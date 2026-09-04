// CodeCraft Studio - multi-language lexer.
//
// A single tokenizer serves every supported language by varying comment and
// string syntax through a per-language dialect. It is deliberately lexical
// rather than a full parser: the goal is a fast, robust structural view of code
// that may well be mid-edit and syntactically incomplete.

#pragma once

#include <cstddef>
#include <string>
#include <vector>

namespace codecraft {

enum class TokenKind {
    Identifier,
    Keyword,
    Number,
    String,
    Comment,
    Operator,
    OpenBrace,
    CloseBrace,
    OpenParen,
    CloseParen,
    OpenBracket,
    CloseBracket,
    Newline,
    Unknown,
};

const char* to_string(TokenKind kind);

struct Token {
    TokenKind kind = TokenKind::Unknown;
    std::string text;
    std::size_t line = 1;    // 1-based
    std::size_t column = 1;  // 1-based
};

// Per-language lexical rules. The defaults describe a C-like language.
struct Dialect {
    std::string name = "generic";
    std::vector<std::string> line_comments{"//"};
    std::string block_comment_open = "/*";
    std::string block_comment_close = "*/";
    std::vector<char> string_delimiters{'"', '\''};
    bool backslash_escapes = true;
    // Languages whose blocks come from indentation rather than braces.
    bool indentation_scoped = false;
    std::vector<std::string> keywords;
    // Keywords that introduce a named declaration (function, class, module).
    std::vector<std::string> declaration_keywords;
    // Keywords that add a branch, used for the cyclomatic complexity estimate.
    std::vector<std::string> branch_keywords;

    bool is_keyword(const std::string& word) const;
    bool is_declaration(const std::string& word) const;
    bool is_branch(const std::string& word) const;
};

// Look up the dialect for a runtime id from the registry ("cpp", "python",
// "rust", ...). Unknown ids fall back to the C-like default.
Dialect dialect_for(const std::string& language);

std::vector<Token> tokenize(const std::string& source, const Dialect& dialect);

}  // namespace codecraft
