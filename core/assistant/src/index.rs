//! Workspace symbol index.
//!
//! A lexical scanner that extracts declarations across the languages CodeCraft
//! supports. It is deliberately not a parser: it must stay useful on code that
//! is mid-edit and syntactically broken, and it must run fast enough to rebuild
//! on every keystroke.
//!
//! Indexing a file is O(bytes) with no allocation per token beyond the symbol
//! names themselves, which is what keeps completion answers in the microsecond
//! range rather than the millisecond range.

use crate::protocol::{SourceFile, Symbol};
use std::collections::HashMap;

/// Declaration keywords per language family, and what kind of symbol follows.
struct Rules {
    /// (keyword, symbol kind)
    declarations: &'static [(&'static str, &'static str)],
    line_comment: &'static [&'static str],
    /// Keywords offered as completions.
    keywords: &'static [&'static str],
}

const C_LIKE_KEYWORDS: &[&str] = &[
    "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "return",
    "struct", "class", "enum", "union", "const", "static", "void", "int", "char", "bool",
    "float", "double", "long", "short", "unsigned", "signed", "sizeof", "typedef", "public",
    "private", "protected", "virtual", "template", "namespace", "using", "try", "catch",
    "throw", "new", "delete", "nullptr", "true", "false", "auto", "inline", "constexpr",
];

const PYTHON_KEYWORDS: &[&str] = &[
    "def", "class", "if", "elif", "else", "for", "while", "try", "except", "finally",
    "with", "as", "import", "from", "return", "yield", "lambda", "pass", "break",
    "continue", "raise", "assert", "global", "nonlocal", "async", "await", "None",
    "True", "False", "and", "or", "not", "in", "is", "self",
];

const RUST_KEYWORDS: &[&str] = &[
    "fn", "let", "mut", "const", "static", "struct", "enum", "trait", "impl", "mod",
    "pub", "use", "match", "if", "else", "loop", "while", "for", "in", "return", "self",
    "Self", "where", "async", "await", "move", "ref", "dyn", "unsafe", "type", "as",
    "Some", "None", "Ok", "Err", "Vec", "String", "Option", "Result",
];

fn rules_for(language: &str) -> Rules {
    match language {
        "python" | "pypy" => Rules {
            declarations: &[("def", "function"), ("class", "class")],
            line_comment: &["#"],
            keywords: PYTHON_KEYWORDS,
        },
        "rust" => Rules {
            declarations: &[
                ("fn", "function"),
                ("struct", "struct"),
                ("enum", "enum"),
                ("trait", "trait"),
                ("impl", "impl"),
                ("mod", "module"),
                ("type", "type"),
                ("const", "constant"),
                ("static", "constant"),
            ],
            line_comment: &["//"],
            keywords: RUST_KEYWORDS,
        },
        "go" => Rules {
            declarations: &[
                ("func", "function"),
                ("type", "type"),
                ("var", "variable"),
                ("const", "constant"),
                ("package", "module"),
            ],
            line_comment: &["//"],
            keywords: &[
                "func", "var", "const", "type", "struct", "interface", "map", "chan", "go",
                "defer", "if", "else", "for", "range", "switch", "case", "return", "package",
                "import", "nil", "true", "false", "make", "new", "len", "cap", "append",
            ],
        },
        "javascript" | "typescript" | "bun" => Rules {
            declarations: &[
                ("function", "function"),
                ("class", "class"),
                ("const", "constant"),
                ("let", "variable"),
                ("var", "variable"),
                ("interface", "interface"),
                ("type", "type"),
                ("enum", "enum"),
            ],
            line_comment: &["//"],
            keywords: &[
                "function", "class", "const", "let", "var", "if", "else", "for", "while",
                "return", "async", "await", "import", "export", "default", "new", "this",
                "try", "catch", "finally", "throw", "typeof", "instanceof", "interface",
                "type", "enum", "extends", "implements", "null", "undefined", "true", "false",
            ],
        },
        "java" | "kotlin" | "scala" | "csharp" | "groovy" => Rules {
            declarations: &[
                ("class", "class"),
                ("interface", "interface"),
                ("enum", "enum"),
                ("record", "class"),
                ("fun", "function"),
                ("def", "function"),
                ("object", "object"),
                ("trait", "trait"),
                ("struct", "struct"),
                ("namespace", "module"),
            ],
            line_comment: &["//"],
            keywords: C_LIKE_KEYWORDS,
        },
        "ruby" => Rules {
            declarations: &[("def", "function"), ("class", "class"), ("module", "module")],
            line_comment: &["#"],
            keywords: &[
                "def", "class", "module", "end", "if", "elsif", "else", "unless", "while",
                "until", "for", "do", "begin", "rescue", "ensure", "return", "yield",
                "require", "attr_accessor", "nil", "true", "false", "self", "puts",
            ],
        },
        "php" => Rules {
            declarations: &[
                ("function", "function"),
                ("class", "class"),
                ("interface", "interface"),
                ("trait", "trait"),
            ],
            line_comment: &["//", "#"],
            keywords: C_LIKE_KEYWORDS,
        },
        "bash" | "zsh" => Rules {
            declarations: &[("function", "function")],
            line_comment: &["#"],
            keywords: &[
                "if", "then", "elif", "else", "fi", "for", "while", "do", "done", "case",
                "esac", "function", "return", "local", "export", "readonly", "echo", "printf",
                "set", "trap", "shift",
            ],
        },
        "lua" => Rules {
            declarations: &[("function", "function"), ("local", "variable")],
            line_comment: &["--"],
            keywords: &[
                "function", "local", "if", "then", "else", "elseif", "end", "for", "while",
                "do", "repeat", "until", "return", "nil", "true", "false", "and", "or", "not",
            ],
        },
        _ => Rules {
            declarations: &[
                ("fn", "function"),
                ("func", "function"),
                ("function", "function"),
                ("def", "function"),
                ("class", "class"),
                ("struct", "struct"),
                ("enum", "enum"),
                ("interface", "interface"),
            ],
            line_comment: &["//", "#"],
            keywords: C_LIKE_KEYWORDS,
        },
    }
}

fn is_identifier_start(ch: char) -> bool {
    ch.is_alphabetic() || ch == '_' || ch == '$'
}

fn is_identifier_char(ch: char) -> bool {
    ch.is_alphanumeric() || ch == '_' || ch == '$'
}

/// Strip a trailing signature so `main(argc` becomes `main`.
fn clean_name(raw: &str) -> &str {
    let end = raw
        .find(|c: char| !is_identifier_char(c))
        .unwrap_or(raw.len());
    &raw[..end]
}

pub struct Index {
    pub symbols: Vec<Symbol>,
    /// Every identifier seen, with how often. Frequency ranks completions:
    /// a name used five times in this file is a likelier completion than one
    /// used once.
    pub identifiers: HashMap<String, usize>,
    pub keywords: &'static [&'static str],
}

impl Index {
    pub fn build(language: &str, files: &[SourceFile]) -> Self {
        let rules = rules_for(language);
        let mut symbols = Vec::new();
        let mut identifiers: HashMap<String, usize> = HashMap::new();

        for file in files {
            for (offset, raw_line) in file.content.lines().enumerate() {
                let line_number = offset + 1;
                let trimmed = raw_line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                let is_comment = rules
                    .line_comment
                    .iter()
                    .any(|marker| trimmed.starts_with(marker));

                // Collect identifiers even from comments: names in a doc comment
                // are still names the author is likely to type next.
                let mut chars = trimmed.char_indices().peekable();
                while let Some((start, ch)) = chars.next() {
                    if !is_identifier_start(ch) {
                        continue;
                    }
                    let mut end = start + ch.len_utf8();
                    while let Some(&(index, next)) = chars.peek() {
                        if is_identifier_char(next) {
                            end = index + next.len_utf8();
                            chars.next();
                        } else {
                            break;
                        }
                    }
                    let word = &trimmed[start..end];
                    if word.len() > 1 {
                        *identifiers.entry(word.to_string()).or_insert(0) += 1;
                    }
                }

                if is_comment {
                    continue;
                }

                // A declaration is a keyword followed by a name. Modifiers may
                // precede it, so scan the leading words rather than only the first.
                let mut words = trimmed.split_whitespace();
                let mut scanned = 0;
                while let Some(word) = words.next() {
                    scanned += 1;
                    if scanned > 4 {
                        break;
                    }
                    let bare = word.trim_end_matches(|c: char| !is_identifier_char(c));
                    if let Some((_, kind)) = rules
                        .declarations
                        .iter()
                        .find(|(keyword, _)| *keyword == bare)
                    {
                        // A method may carry a receiver before its name, as in
                        // Go's `func (s *Server) Start()`. Skip the receiver
                        // group rather than indexing it as the symbol.
                        let mut candidate = words.next();
                        if candidate.map_or(false, |word| word.starts_with('(')) {
                            for word in words.by_ref() {
                                if word.ends_with(')') {
                                    break;
                                }
                            }
                            candidate = words.next();
                        }

                        if let Some(candidate) = candidate {
                            let name = clean_name(candidate);
                            if !name.is_empty() && is_identifier_start(name.chars().next().unwrap())
                            {
                                symbols.push(Symbol {
                                    name: name.to_string(),
                                    kind: (*kind).to_string(),
                                    file: file.name.clone(),
                                    line: line_number,
                                    detail: trimmed.chars().take(120).collect(),
                                });
                            }
                        }
                        break;
                    }
                }
            }
        }

        Index {
            symbols,
            identifiers,
            keywords: rules.keywords,
        }
    }

    pub fn find(&self, name: &str) -> Option<&Symbol> {
        self.symbols.iter().find(|symbol| symbol.name == name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, content: &str) -> SourceFile {
        SourceFile {
            name: name.to_string(),
            content: content.to_string(),
        }
    }

    #[test]
    fn indexes_python_declarations() {
        let files = vec![file(
            "main.py",
            "class Engine:\n    def start(self):\n        return 1\n\ndef main():\n    pass\n",
        )];
        let index = Index::build("python", &files);
        let names: Vec<_> = index.symbols.iter().map(|s| s.name.as_str()).collect();
        assert!(names.contains(&"Engine"));
        assert!(names.contains(&"start"));
        assert!(names.contains(&"main"));
        assert_eq!(index.find("Engine").unwrap().kind, "class");
    }

    #[test]
    fn indexes_rust_declarations_behind_modifiers() {
        let files = vec![file(
            "lib.rs",
            "pub struct Config { size: usize }\npub async fn connect() {}\n",
        )];
        let index = Index::build("rust", &files);
        assert_eq!(index.find("Config").unwrap().kind, "struct");
        assert_eq!(index.find("connect").unwrap().kind, "function");
    }

    #[test]
    fn indexes_a_method_past_its_receiver() {
        let files = vec![file(
            "main.go",
            "package main\n\ntype Server struct{}\n\nfunc (s *Server) Start() {}\n\nfunc main() {}\n",
        )];
        let index = Index::build("go", &files);
        assert_eq!(index.find("Start").unwrap().kind, "function");
        assert!(index.find("s").is_none(), "the receiver is not a symbol");
        assert!(index.find("Server").is_some());
    }

    #[test]
    fn ignores_declarations_inside_comments() {
        let files = vec![file("main.rs", "// fn commented_out() {}\nfn real() {}\n")];
        let index = Index::build("rust", &files);
        assert!(index.find("commented_out").is_none());
        assert!(index.find("real").is_some());
    }

    #[test]
    fn counts_identifier_frequency() {
        let files = vec![file("main.py", "total = 0\ntotal = total + 1\n")];
        let index = Index::build("python", &files);
        assert_eq!(index.identifiers.get("total"), Some(&3));
    }

    #[test]
    fn survives_broken_source() {
        let files = vec![file("main.rs", "fn \n\nstruct\n   {{{ ][ \nfn ok() {}\n")];
        let index = Index::build("rust", &files);
        assert!(index.find("ok").is_some());
    }

    #[test]
    fn handles_multibyte_identifiers() {
        let files = vec![file("main.py", "def café(): pass\nvariabilă = 1\n")];
        let index = Index::build("python", &files);
        assert!(index.find("café").is_some());
        assert!(index.identifiers.contains_key("variabilă"));
    }
}
