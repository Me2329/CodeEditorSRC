//! The local engine.
//!
//! Answers the questions that do not need a language model, from the workspace
//! index alone. No network, no model, no allocation beyond the answer itself:
//! these replies come back in microseconds, which is what makes completion feel
//! instant while the model handles the work that genuinely needs reasoning.

use crate::index::Index;
use crate::protocol::{Completion, Workspace};

/// Score a candidate against what the user has typed.
///
/// Exact prefix beats camel-case initials beats subsequence, and shorter
/// candidates win ties because they are what the user most likely meant.
/// Returns None when the candidate does not match at all.
pub fn score_candidate(prefix: &str, candidate: &str) -> Option<i64> {
    if prefix.is_empty() {
        return Some(0);
    }
    if candidate == prefix {
        return None; // Offering what is already typed is noise.
    }

    let lower_prefix = prefix.to_lowercase();
    let lower_candidate = candidate.to_lowercase();

    let mut score = if candidate.starts_with(prefix) {
        1000
    } else if lower_candidate.starts_with(&lower_prefix) {
        900
    } else if matches_initials(prefix, candidate) {
        700
    } else if let Some(position) = lower_candidate.find(&lower_prefix) {
        // A contained match, penalised by how far in it starts.
        500 - (position as i64).min(200)
    } else if is_subsequence(&lower_prefix, &lower_candidate) {
        200
    } else {
        return None;
    };

    // Prefer shorter completions: "len" over "lengthy_helper_name".
    score -= (candidate.len() as i64).min(60);
    Some(score)
}

/// Does `prefix` match the capitals of a camel or Pascal case name?
/// "hm" matches "HashMap"; "sw" matches "startsWith".
fn matches_initials(prefix: &str, candidate: &str) -> bool {
    if prefix.len() < 2 {
        return false;
    }
    let mut initials = String::new();
    let mut previous_was_separator = true;
    for ch in candidate.chars() {
        if ch == '_' || ch == '-' {
            previous_was_separator = true;
            continue;
        }
        if ch.is_uppercase() || previous_was_separator {
            initials.push(ch.to_ascii_lowercase());
        }
        previous_was_separator = false;
    }
    initials.starts_with(&prefix.to_lowercase())
}

fn is_subsequence(needle: &str, haystack: &str) -> bool {
    let mut characters = haystack.chars();
    needle
        .chars()
        .all(|target| characters.any(|current| current == target))
}

/// Completion candidates at the caret, best first.
pub fn complete(index: &Index, prefix: &str, limit: usize) -> Vec<Completion> {
    let mut items: Vec<Completion> = Vec::new();

    // Declared symbols rank highest: they are what this workspace is made of.
    for symbol in &index.symbols {
        if let Some(score) = score_candidate(prefix, &symbol.name) {
            items.push(Completion {
                label: symbol.name.clone(),
                kind: symbol.kind.clone(),
                detail: format!("{} · {}:{}", symbol.kind, symbol.file, symbol.line),
                score: score + 300,
            });
        }
    }

    // Then identifiers seen elsewhere, ranked by how often they appear.
    for (identifier, count) in &index.identifiers {
        if index.symbols.iter().any(|s| &s.name == identifier) {
            continue;
        }
        if let Some(score) = score_candidate(prefix, identifier) {
            items.push(Completion {
                label: identifier.clone(),
                kind: "text".to_string(),
                detail: format!("used {} times", count),
                score: score + (*count as i64).min(50),
            });
        }
    }

    // Language keywords last: always available, rarely what you want ranked top.
    for keyword in index.keywords {
        if let Some(score) = score_candidate(prefix, keyword) {
            items.push(Completion {
                label: (*keyword).to_string(),
                kind: "keyword".to_string(),
                detail: "keyword".to_string(),
                score,
            });
        }
    }

    items.sort_by(|a, b| b.score.cmp(&a.score).then_with(|| a.label.cmp(&b.label)));
    items.dedup_by(|a, b| a.label == b.label);
    items.truncate(limit);
    items
}

/// A structural description of a symbol, or of the workspace when no symbol is
/// named. This is what the model would otherwise be asked for, answered from
/// the index instead.
pub fn explain(index: &Index, workspace: &Workspace, symbol_name: &str) -> String {
    if !symbol_name.is_empty() {
        if let Some(symbol) = index.find(symbol_name) {
            let mut out = format!(
                "`{}` is a {} declared in {} at line {}.\n\n    {}\n",
                symbol.name, symbol.kind, symbol.file, symbol.line, symbol.detail
            );

            let references = index
                .identifiers
                .get(&symbol.name)
                .copied()
                .unwrap_or(0)
                .saturating_sub(1);
            if references > 0 {
                out.push_str(&format!(
                    "\nIt is referenced {} more time{} in this workspace.\n",
                    references,
                    if references == 1 { "" } else { "s" }
                ));
            } else {
                out.push_str("\nNothing else in this workspace references it.\n");
            }
            return out;
        }
        return format!(
            "No declaration named `{}` is indexed in this workspace. \
             It may come from a library, or the file may not be open.",
            symbol_name
        );
    }

    // No symbol named: describe the workspace.
    let total_lines: usize = workspace
        .files
        .iter()
        .map(|file| file.content.lines().count())
        .sum();

    let mut out = format!(
        "{} file{} · {} lines · {} declaration{}.\n",
        workspace.files.len(),
        if workspace.files.len() == 1 { "" } else { "s" },
        total_lines,
        index.symbols.len(),
        if index.symbols.len() == 1 { "" } else { "s" }
    );

    if index.symbols.is_empty() {
        out.push_str("\nNo declarations found yet.\n");
        return out;
    }

    out.push_str("\nDeclarations:\n");
    for symbol in index.symbols.iter().take(40) {
        out.push_str(&format!(
            "  {:<10} {:<24} {}:{}\n",
            symbol.kind, symbol.name, symbol.file, symbol.line
        ));
    }
    if index.symbols.len() > 40 {
        out.push_str(&format!("  … and {} more\n", index.symbols.len() - 40));
    }
    out
}

/// Decide whether the local engine can answer a chat message well.
///
/// The rule is deliberately conservative: route locally only for the narrow
/// questions the index genuinely answers better than a model would (instantly,
/// and grounded in this exact workspace). Everything else goes to the model.
pub fn can_answer_locally(message: &str) -> Option<LocalIntent> {
    let normalised = message.trim().to_lowercase();
    if normalised.len() > 200 {
        return None;
    }

    const OUTLINE: &[&str] = &[
        "what functions", "list functions", "list the functions", "what symbols",
        "list symbols", "outline", "what classes", "list classes", "structure of this file",
        "what's in this file", "what is in this file",
    ];
    if OUTLINE.iter().any(|phrase| normalised.contains(phrase)) {
        return Some(LocalIntent::Outline);
    }

    const WHERE: &[&str] = &["where is", "where's", "find the definition", "go to definition"];
    for phrase in WHERE {
        if let Some(position) = normalised.find(phrase) {
            let tail = message[position + phrase.len()..].trim();
            let name: String = tail
                .trim_start_matches(|c: char| !c.is_alphanumeric() && c != '_')
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '_')
                .collect();
            if !name.is_empty() {
                return Some(LocalIntent::Locate(name));
            }
        }
    }

    const COUNT: &[&str] = &["how many lines", "how many files", "how many functions"];
    if COUNT.iter().any(|phrase| normalised.contains(phrase)) {
        return Some(LocalIntent::Outline);
    }

    None
}

#[derive(Debug, PartialEq)]
pub enum LocalIntent {
    Outline,
    Locate(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::SourceFile;

    fn index_of(language: &str, content: &str) -> Index {
        Index::build(
            language,
            &[SourceFile {
                name: "main.rs".into(),
                content: content.into(),
            }],
        )
    }

    #[test]
    fn exact_prefix_outranks_a_subsequence() {
        let prefix = score_candidate("conn", "connect").unwrap();
        let subsequence = score_candidate("conn", "cannot_open_now").unwrap();
        assert!(prefix > subsequence);
    }

    #[test]
    fn camel_case_initials_match() {
        assert!(score_candidate("hm", "HashMap").is_some());
        assert!(score_candidate("sw", "startsWith").is_some());
        assert!(score_candidate("xy", "HashMap").is_none());
    }

    #[test]
    fn shorter_candidates_win_ties() {
        let short = score_candidate("len", "length").unwrap();
        let long = score_candidate("len", "lengthy_helper_function").unwrap();
        assert!(short > long);
    }

    #[test]
    fn never_suggests_exactly_what_is_typed() {
        assert!(score_candidate("connect", "connect").is_none());
    }

    #[test]
    fn declared_symbols_outrank_keywords() {
        let index = index_of("rust", "fn iffy_helper() {}\n");
        let items = complete(&index, "if", 10);
        assert_eq!(items[0].label, "iffy_helper");
    }

    #[test]
    fn completion_respects_the_limit() {
        let index = index_of("rust", "fn alpha() {} fn alberta() {} fn albatross() {}\n");
        assert!(complete(&index, "al", 2).len() <= 2);
    }

    #[test]
    fn explain_reports_a_symbol_and_its_references() {
        let index = index_of("rust", "fn helper() {}\nfn main() { helper(); helper(); }\n");
        let workspace = Workspace::default();
        let text = explain(&index, &workspace, "helper");
        assert!(text.contains("function"));
        assert!(text.contains("line 1"));
        assert!(text.contains("referenced"));
    }

    #[test]
    fn explain_is_honest_about_an_unknown_symbol() {
        let index = index_of("rust", "fn main() {}\n");
        let text = explain(&index, &Workspace::default(), "nonexistent");
        assert!(text.contains("No declaration named"));
    }

    #[test]
    fn routes_outline_questions_locally() {
        assert_eq!(
            can_answer_locally("what functions are in this file?"),
            Some(LocalIntent::Outline)
        );
        assert_eq!(
            can_answer_locally("where is parse_config"),
            Some(LocalIntent::Locate("parse_config".into()))
        );
    }

    #[test]
    fn sends_real_questions_to_the_model() {
        for message in [
            "why does this segfault?",
            "rewrite this to use async",
            "explain the borrow checker error on line 12",
            "write a binary search in C++",
        ] {
            assert!(
                can_answer_locally(message).is_none(),
                "should not answer locally: {message}"
            );
        }
    }
}
