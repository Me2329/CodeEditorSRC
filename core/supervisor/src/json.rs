//! A minimal JSON reader and writer.
//!
//! The supervisor is the component closest to untrusted code, so it carries no
//! third-party dependencies. This module implements exactly the subset of JSON
//! the wire protocol needs: parsing request objects and serialising response
//! frames, with correct string escaping in both directions.

use std::collections::BTreeMap;
use std::fmt::Write as _;

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(map) => map.get(key),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(n) => Some(*n),
            _ => None,
        }
    }

    pub fn as_u64(&self) -> Option<u64> {
        self.as_f64()
            .filter(|n| n.is_finite() && *n >= 0.0)
            .map(|n| n as u64)
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Json::Bool(b) => Some(*b),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    /// Serialise to compact JSON. Control characters are escaped, so arbitrary
    /// program output survives the trip to the client intact.
    pub fn to_string(&self) -> String {
        let mut out = String::new();
        self.write_to(&mut out);
        out
    }

    fn write_to(&self, out: &mut String) {
        match self {
            Json::Null => out.push_str("null"),
            Json::Bool(true) => out.push_str("true"),
            Json::Bool(false) => out.push_str("false"),
            Json::Number(n) => {
                if n.is_finite() {
                    // Emit integral values without a trailing ".0".
                    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
                        let _ = write!(out, "{}", *n as i64);
                    } else {
                        let _ = write!(out, "{}", n);
                    }
                } else {
                    out.push_str("null");
                }
            }
            Json::String(s) => escape_into(s, out),
            Json::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    item.write_to(out);
                }
                out.push(']');
            }
            Json::Object(map) => {
                out.push('{');
                for (i, (key, value)) in map.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    escape_into(key, out);
                    out.push(':');
                    value.write_to(out);
                }
                out.push('}');
            }
        }
    }
}

fn escape_into(s: &str, out: &mut String) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Build a JSON object from key/value pairs, keeping call sites readable.
#[macro_export]
macro_rules! json_object {
    ($($key:expr => $value:expr),* $(,)?) => {{
        let mut map = std::collections::BTreeMap::new();
        $( map.insert($key.to_string(), $value); )*
        $crate::json::Json::Object(map)
    }};
}

pub fn string(value: impl Into<String>) -> Json {
    Json::String(value.into())
}

pub fn number(value: impl Into<f64>) -> Json {
    Json::Number(value.into())
}

pub fn bool(value: bool) -> Json {
    Json::Bool(value)
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

pub fn parse(input: &str) -> Result<Json, String> {
    let bytes: Vec<char> = input.chars().collect();
    let mut parser = Parser { chars: &bytes, pos: 0, depth: 0 };
    parser.skip_whitespace();
    let value = parser.parse_value()?;
    parser.skip_whitespace();
    if parser.pos != parser.chars.len() {
        return Err(format!("trailing input at character {}", parser.pos));
    }
    Ok(value)
}

/// Guards against stack exhaustion from a deeply nested hostile payload.
const MAX_DEPTH: usize = 64;

struct Parser<'a> {
    chars: &'a [char],
    pos: usize,
    depth: usize,
}

impl<'a> Parser<'a> {
    fn peek(&self) -> Option<char> {
        self.chars.get(self.pos).copied()
    }

    fn next(&mut self) -> Option<char> {
        let ch = self.peek();
        if ch.is_some() {
            self.pos += 1;
        }
        ch
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(' ') | Some('\t') | Some('\n') | Some('\r')) {
            self.pos += 1;
        }
    }

    fn expect(&mut self, expected: char) -> Result<(), String> {
        match self.next() {
            Some(ch) if ch == expected => Ok(()),
            Some(ch) => Err(format!("expected '{}' but found '{}' at {}", expected, ch, self.pos)),
            None => Err(format!("expected '{}' but input ended", expected)),
        }
    }

    fn parse_value(&mut self) -> Result<Json, String> {
        if self.depth > MAX_DEPTH {
            return Err("JSON nesting is too deep".to_string());
        }
        match self.peek() {
            Some('{') => self.parse_object(),
            Some('[') => self.parse_array(),
            Some('"') => Ok(Json::String(self.parse_string()?)),
            Some('t') => self.parse_literal("true", Json::Bool(true)),
            Some('f') => self.parse_literal("false", Json::Bool(false)),
            Some('n') => self.parse_literal("null", Json::Null),
            Some(c) if c == '-' || c.is_ascii_digit() => self.parse_number(),
            Some(c) => Err(format!("unexpected character '{}' at {}", c, self.pos)),
            None => Err("unexpected end of input".to_string()),
        }
    }

    fn parse_literal(&mut self, literal: &str, value: Json) -> Result<Json, String> {
        for expected in literal.chars() {
            self.expect(expected)?;
        }
        Ok(value)
    }

    fn parse_object(&mut self) -> Result<Json, String> {
        self.expect('{')?;
        self.depth += 1;
        let mut map = BTreeMap::new();
        self.skip_whitespace();
        if self.peek() == Some('}') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Object(map));
        }
        loop {
            self.skip_whitespace();
            let key = self.parse_string()?;
            self.skip_whitespace();
            self.expect(':')?;
            self.skip_whitespace();
            let value = self.parse_value()?;
            map.insert(key, value);
            self.skip_whitespace();
            match self.next() {
                Some(',') => continue,
                Some('}') => break,
                Some(ch) => return Err(format!("expected ',' or '}}' but found '{}'", ch)),
                None => return Err("unterminated object".to_string()),
            }
        }
        self.depth -= 1;
        Ok(Json::Object(map))
    }

    fn parse_array(&mut self) -> Result<Json, String> {
        self.expect('[')?;
        self.depth += 1;
        let mut items = Vec::new();
        self.skip_whitespace();
        if self.peek() == Some(']') {
            self.pos += 1;
            self.depth -= 1;
            return Ok(Json::Array(items));
        }
        loop {
            self.skip_whitespace();
            items.push(self.parse_value()?);
            self.skip_whitespace();
            match self.next() {
                Some(',') => continue,
                Some(']') => break,
                Some(ch) => return Err(format!("expected ',' or ']' but found '{}'", ch)),
                None => return Err("unterminated array".to_string()),
            }
        }
        self.depth -= 1;
        Ok(Json::Array(items))
    }

    fn parse_string(&mut self) -> Result<String, String> {
        self.expect('"')?;
        let mut out = String::new();
        loop {
            match self.next() {
                None => return Err("unterminated string".to_string()),
                Some('"') => break,
                Some('\\') => match self.next() {
                    Some('"') => out.push('"'),
                    Some('\\') => out.push('\\'),
                    Some('/') => out.push('/'),
                    Some('n') => out.push('\n'),
                    Some('r') => out.push('\r'),
                    Some('t') => out.push('\t'),
                    Some('b') => out.push('\u{08}'),
                    Some('f') => out.push('\u{0c}'),
                    Some('u') => out.push(self.parse_unicode_escape()?),
                    Some(ch) => return Err(format!("invalid escape '\\{}'", ch)),
                    None => return Err("unterminated escape sequence".to_string()),
                },
                Some(ch) => out.push(ch),
            }
        }
        Ok(out)
    }

    fn parse_unicode_escape(&mut self) -> Result<char, String> {
        let high = self.parse_hex4()?;
        // A surrogate pair arrives as two consecutive \u escapes.
        if (0xD800..0xDC00).contains(&high) {
            if self.peek() == Some('\\') {
                self.pos += 1;
                self.expect('u')?;
                let low = self.parse_hex4()?;
                if (0xDC00..0xE000).contains(&low) {
                    let combined = 0x10000 + ((high - 0xD800) << 10) + (low - 0xDC00);
                    return char::from_u32(combined)
                        .ok_or_else(|| "invalid surrogate pair".to_string());
                }
                return Err("unpaired high surrogate".to_string());
            }
            return Err("unpaired high surrogate".to_string());
        }
        char::from_u32(high).ok_or_else(|| "invalid unicode escape".to_string())
    }

    fn parse_hex4(&mut self) -> Result<u32, String> {
        let mut value = 0u32;
        for _ in 0..4 {
            let ch = self.next().ok_or_else(|| "truncated unicode escape".to_string())?;
            let digit = ch
                .to_digit(16)
                .ok_or_else(|| format!("invalid hex digit '{}'", ch))?;
            value = value * 16 + digit;
        }
        Ok(value)
    }

    fn parse_number(&mut self) -> Result<Json, String> {
        let start = self.pos;
        if self.peek() == Some('-') {
            self.pos += 1;
        }
        while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
            self.pos += 1;
        }
        if self.peek() == Some('.') {
            self.pos += 1;
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some('e') | Some('E')) {
            self.pos += 1;
            if matches!(self.peek(), Some('+') | Some('-')) {
                self.pos += 1;
            }
            while matches!(self.peek(), Some(c) if c.is_ascii_digit()) {
                self.pos += 1;
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.parse::<f64>()
            .map(Json::Number)
            .map_err(|_| format!("invalid number '{}'", text))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_nested_objects_and_arrays() {
        let value = parse(r#"{"a":[1,2,{"b":true}],"c":null}"#).unwrap();
        assert_eq!(value.get("a").unwrap().as_array().unwrap().len(), 3);
        assert_eq!(value.get("c"), Some(&Json::Null));
    }

    #[test]
    fn round_trips_control_characters() {
        let original = "line\nbreak\ttab\u{1}bell\"quote\\slash";
        let encoded = Json::String(original.to_string()).to_string();
        assert_eq!(parse(&encoded).unwrap().as_str().unwrap(), original);
    }

    #[test]
    fn decodes_surrogate_pairs() {
        let value = parse(r#""🚀""#).unwrap();
        assert_eq!(value.as_str().unwrap(), "\u{1F680}");
    }

    #[test]
    fn rejects_trailing_input() {
        assert!(parse(r#"{"a":1} extra"#).is_err());
    }

    #[test]
    fn rejects_excessive_nesting() {
        let deep = format!("{}{}", "[".repeat(200), "]".repeat(200));
        assert!(parse(&deep).is_err());
    }

    #[test]
    fn writes_integers_without_decimal_point() {
        assert_eq!(Json::Number(42.0).to_string(), "42");
    }
}
