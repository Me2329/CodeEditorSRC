#include "codecraft/lexer.hpp"

#include <algorithm>
#include <cctype>
#include <unordered_map>

namespace codecraft {
namespace {

bool starts_with_at(const std::string& source, std::size_t pos, const std::string& needle) {
    return !needle.empty() && source.compare(pos, needle.size(), needle) == 0;
}

bool is_identifier_start(char ch) {
    return std::isalpha(static_cast<unsigned char>(ch)) || ch == '_' || ch == '$';
}

bool is_identifier_char(char ch) {
    return std::isalnum(static_cast<unsigned char>(ch)) || ch == '_' || ch == '$';
}

// Shared keyword groups. Languages differ in detail, but the branch keywords
// that drive complexity scoring overlap heavily, so they are factored out.
const std::vector<std::string> kCLikeBranches{
    "if", "else", "for", "while", "case", "catch", "&&", "||", "?", "switch", "do"};

Dialect c_like(std::string name) {
    Dialect dialect;
    dialect.name = std::move(name);
    dialect.keywords = {"auto", "break", "case", "char", "const", "continue", "default", "do",
                        "double", "else", "enum", "extern", "float", "for", "goto", "if", "int",
                        "long", "register", "return", "short", "signed", "sizeof", "static",
                        "struct", "switch", "typedef", "union", "unsigned", "void", "volatile",
                        "while", "class", "namespace", "template", "public", "private",
                        "protected", "virtual", "try", "catch", "throw", "new", "delete",
                        "using", "constexpr", "nullptr", "bool", "true", "false", "inline"};
    dialect.declaration_keywords = {"class", "struct", "enum", "union", "namespace", "template",
                                    "typedef"};
    dialect.branch_keywords = kCLikeBranches;
    return dialect;
}

}  // namespace

const char* to_string(TokenKind kind) {
    switch (kind) {
        case TokenKind::Identifier:   return "identifier";
        case TokenKind::Keyword:      return "keyword";
        case TokenKind::Number:       return "number";
        case TokenKind::String:       return "string";
        case TokenKind::Comment:      return "comment";
        case TokenKind::Operator:     return "operator";
        case TokenKind::OpenBrace:    return "open_brace";
        case TokenKind::CloseBrace:   return "close_brace";
        case TokenKind::OpenParen:    return "open_paren";
        case TokenKind::CloseParen:   return "close_paren";
        case TokenKind::OpenBracket:  return "open_bracket";
        case TokenKind::CloseBracket: return "close_bracket";
        case TokenKind::Newline:      return "newline";
        case TokenKind::Unknown:      return "unknown";
    }
    return "unknown";
}

bool Dialect::is_keyword(const std::string& word) const {
    return std::find(keywords.begin(), keywords.end(), word) != keywords.end();
}

bool Dialect::is_declaration(const std::string& word) const {
    return std::find(declaration_keywords.begin(), declaration_keywords.end(), word)
           != declaration_keywords.end();
}

bool Dialect::is_branch(const std::string& word) const {
    return std::find(branch_keywords.begin(), branch_keywords.end(), word)
           != branch_keywords.end();
}

Dialect dialect_for(const std::string& language) {
    if (language == "c" || language == "cpp" || language == "csharp" || language == "java"
        || language == "kotlin" || language == "scala" || language == "swift"
        || language == "dart" || language == "groovy" || language == "d"
        || language == "javascript" || language == "typescript" || language == "bun"
        || language == "go" || language == "php" || language == "zig") {
        Dialect dialect = c_like(language);
        if (language == "go") {
            dialect.keywords = {"break", "case", "chan", "const", "continue", "default", "defer",
                                "else", "fallthrough", "for", "func", "go", "goto", "if",
                                "import", "interface", "map", "package", "range", "return",
                                "select", "struct", "switch", "type", "var"};
            dialect.declaration_keywords = {"func", "type", "struct", "interface", "package"};
            dialect.string_delimiters = {'"', '\'', '`'};
        } else if (language == "javascript" || language == "typescript" || language == "bun") {
            dialect.keywords = {"async", "await", "break", "case", "catch", "class", "const",
                                "continue", "default", "delete", "do", "else", "export",
                                "extends", "finally", "for", "function", "if", "import", "in",
                                "instanceof", "interface", "let", "new", "return", "static",
                                "super", "switch", "this", "throw", "try", "type", "typeof",
                                "var", "void", "while", "yield"};
            dialect.declaration_keywords = {"function", "class", "interface", "type", "const",
                                            "let", "var", "export"};
            dialect.string_delimiters = {'"', '\'', '`'};
        } else if (language == "java" || language == "kotlin" || language == "scala") {
            dialect.declaration_keywords = {"class", "interface", "enum", "record", "fun",
                                            "object", "trait", "def", "package"};
            dialect.keywords.insert(dialect.keywords.end(),
                                    {"package", "import", "implements", "extends", "final",
                                     "abstract", "synchronized", "fun", "val", "var", "object",
                                     "trait", "def"});
        } else if (language == "php") {
            dialect.line_comments = {"//", "#"};
            dialect.declaration_keywords = {"function", "class", "interface", "trait", "enum"};
            dialect.keywords.insert(dialect.keywords.end(),
                                    {"function", "echo", "elseif", "foreach", "as", "require",
                                     "include", "trait", "instanceof"});
        } else if (language == "swift" || language == "dart") {
            dialect.declaration_keywords = {"func", "class", "struct", "enum", "protocol",
                                            "extension", "mixin"};
            dialect.keywords.insert(dialect.keywords.end(),
                                    {"func", "let", "var", "guard", "protocol", "extension"});
        } else if (language == "zig") {
            dialect.declaration_keywords = {"fn", "const", "pub", "struct", "enum", "union"};
            dialect.keywords.insert(dialect.keywords.end(), {"fn", "pub", "comptime", "defer",
                                                             "try", "orelse", "errdefer"});
        }
        return dialect;
    }

    if (language == "rust") {
        Dialect dialect = c_like("rust");
        dialect.keywords = {"as", "async", "await", "break", "const", "continue", "crate", "dyn",
                            "else", "enum", "extern", "false", "fn", "for", "if", "impl", "in",
                            "let", "loop", "match", "mod", "move", "mut", "pub", "ref", "return",
                            "self", "static", "struct", "super", "trait", "true", "type",
                            "unsafe", "use", "where", "while"};
        dialect.declaration_keywords = {"fn", "struct", "enum", "trait", "impl", "mod", "type",
                                        "const", "static"};
        dialect.branch_keywords = {"if", "else", "for", "while", "loop", "match", "&&", "||", "?"};
        return dialect;
    }

    if (language == "python" || language == "pypy") {
        Dialect dialect;
        dialect.name = language;
        dialect.line_comments = {"#"};
        dialect.block_comment_open.clear();
        dialect.block_comment_close.clear();
        dialect.string_delimiters = {'"', '\''};
        dialect.indentation_scoped = true;
        dialect.keywords = {"and", "as", "assert", "async", "await", "break", "class", "continue",
                            "def", "del", "elif", "else", "except", "finally", "for", "from",
                            "global", "if", "import", "in", "is", "lambda", "nonlocal", "not",
                            "or", "pass", "raise", "return", "try", "while", "with", "yield",
                            "None", "True", "False"};
        dialect.declaration_keywords = {"def", "class", "async"};
        dialect.branch_keywords = {"if", "elif", "else", "for", "while", "except", "and", "or"};
        return dialect;
    }

    if (language == "ruby" || language == "perl" || language == "bash" || language == "zsh"
        || language == "r" || language == "julia" || language == "elixir" || language == "awk") {
        Dialect dialect;
        dialect.name = language;
        dialect.line_comments = {"#"};
        dialect.block_comment_open.clear();
        dialect.block_comment_close.clear();
        dialect.string_delimiters = {'"', '\'', '`'};
        dialect.keywords = {"def", "end", "do", "if", "elsif", "else", "unless", "while", "until",
                            "for", "return", "class", "module", "begin", "rescue", "ensure",
                            "then", "case", "when", "function", "local", "fi", "esac", "done"};
        dialect.declaration_keywords = {"def", "class", "module", "function"};
        dialect.branch_keywords = {"if", "elsif", "else", "unless", "while", "until", "for",
                                   "when", "rescue", "&&", "||"};
        if (language == "julia" || language == "r") {
            dialect.declaration_keywords = {"function", "struct", "module"};
        }
        return dialect;
    }

    if (language == "sql") {
        Dialect dialect;
        dialect.name = "sql";
        dialect.line_comments = {"--"};
        dialect.string_delimiters = {'\'', '"'};
        dialect.keywords = {"select", "from", "where", "insert", "into", "values", "update",
                            "set", "delete", "create", "table", "index", "view", "join", "left",
                            "right", "inner", "outer", "on", "group", "order", "by", "having",
                            "limit", "primary", "key", "foreign", "references", "not", "null"};
        dialect.declaration_keywords = {"create"};
        dialect.branch_keywords = {"where", "case", "when", "having", "and", "or"};
        return dialect;
    }

    if (language == "haskell") {
        Dialect dialect;
        dialect.name = "haskell";
        dialect.line_comments = {"--"};
        dialect.block_comment_open = "{-";
        dialect.block_comment_close = "-}";
        dialect.indentation_scoped = true;
        dialect.keywords = {"module", "where", "import", "data", "type", "newtype", "class",
                            "instance", "do", "case", "of", "let", "in", "if", "then", "else"};
        dialect.declaration_keywords = {"module", "data", "newtype", "class", "instance", "type"};
        dialect.branch_keywords = {"if", "case", "of", "guard"};
        return dialect;
    }

    if (language == "html") {
        Dialect dialect;
        dialect.name = "html";
        dialect.line_comments.clear();
        dialect.block_comment_open = "<!--";
        dialect.block_comment_close = "-->";
        dialect.string_delimiters = {'"', '\''};
        dialect.declaration_keywords = {};
        dialect.branch_keywords = {};
        return dialect;
    }

    return c_like(language.empty() ? "generic" : language);
}

std::vector<Token> tokenize(const std::string& source, const Dialect& dialect) {
    std::vector<Token> tokens;
    tokens.reserve(source.size() / 4 + 8);

    std::size_t pos = 0;
    std::size_t line = 1;
    std::size_t line_start = 0;

    const auto column_at = [&](std::size_t index) { return index - line_start + 1; };

    while (pos < source.size()) {
        const char ch = source[pos];

        if (ch == '\n') {
            tokens.push_back({TokenKind::Newline, "\n", line, column_at(pos)});
            ++pos;
            ++line;
            line_start = pos;
            continue;
        }

        if (std::isspace(static_cast<unsigned char>(ch))) {
            ++pos;
            continue;
        }

        // Line comment
        bool matched_line_comment = false;
        for (const std::string& marker : dialect.line_comments) {
            if (starts_with_at(source, pos, marker)) {
                const std::size_t start = pos;
                while (pos < source.size() && source[pos] != '\n') ++pos;
                tokens.push_back({TokenKind::Comment, source.substr(start, pos - start), line,
                                  column_at(start)});
                matched_line_comment = true;
                break;
            }
        }
        if (matched_line_comment) continue;

        // Block comment. An unterminated block runs to end of input; the
        // analyzer reports that as a diagnostic rather than failing here.
        if (!dialect.block_comment_open.empty()
            && starts_with_at(source, pos, dialect.block_comment_open)) {
            const std::size_t start = pos;
            const std::size_t start_line = line;
            const std::size_t start_column = column_at(pos);
            pos += dialect.block_comment_open.size();
            while (pos < source.size()
                   && !starts_with_at(source, pos, dialect.block_comment_close)) {
                if (source[pos] == '\n') { ++line; line_start = pos + 1; }
                ++pos;
            }
            if (pos < source.size()) pos += dialect.block_comment_close.size();
            tokens.push_back({TokenKind::Comment, source.substr(start, pos - start), start_line,
                              start_column});
            continue;
        }

        // String literal
        if (std::find(dialect.string_delimiters.begin(), dialect.string_delimiters.end(), ch)
            != dialect.string_delimiters.end()) {
            const std::size_t start = pos;
            const std::size_t start_line = line;
            const std::size_t start_column = column_at(pos);
            const char quote = ch;

            // Python and friends: a tripled quote opens a multi-line literal.
            const bool triple = pos + 2 < source.size() && source[pos + 1] == quote
                                && source[pos + 2] == quote;
            pos += triple ? 3 : 1;

            while (pos < source.size()) {
                if (dialect.backslash_escapes && source[pos] == '\\' && pos + 1 < source.size()) {
                    if (source[pos + 1] == '\n') { ++line; line_start = pos + 2; }
                    pos += 2;
                    continue;
                }
                if (triple) {
                    if (source[pos] == quote && pos + 2 < source.size() && source[pos + 1] == quote
                        && source[pos + 2] == quote) {
                        pos += 3;
                        break;
                    }
                } else if (source[pos] == quote) {
                    ++pos;
                    break;
                } else if (source[pos] == '\n') {
                    // A single-quoted literal does not survive a newline.
                    break;
                }
                if (source[pos] == '\n') { ++line; line_start = pos + 1; }
                ++pos;
            }
            tokens.push_back({TokenKind::String, source.substr(start, pos - start), start_line,
                              start_column});
            continue;
        }

        // Number
        if (std::isdigit(static_cast<unsigned char>(ch))) {
            const std::size_t start = pos;
            while (pos < source.size()
                   && (std::isalnum(static_cast<unsigned char>(source[pos])) || source[pos] == '.'
                       || source[pos] == '_')) {
                ++pos;
            }
            tokens.push_back({TokenKind::Number, source.substr(start, pos - start), line,
                              column_at(start)});
            continue;
        }

        // Identifier or keyword
        if (is_identifier_start(ch)) {
            const std::size_t start = pos;
            while (pos < source.size() && is_identifier_char(source[pos])) ++pos;
            std::string word = source.substr(start, pos - start);
            const TokenKind kind =
                dialect.is_keyword(word) ? TokenKind::Keyword : TokenKind::Identifier;
            tokens.push_back({kind, std::move(word), line, column_at(start)});
            continue;
        }

        // Delimiters and operators
        TokenKind kind = TokenKind::Operator;
        switch (ch) {
            case '{': kind = TokenKind::OpenBrace; break;
            case '}': kind = TokenKind::CloseBrace; break;
            case '(': kind = TokenKind::OpenParen; break;
            case ')': kind = TokenKind::CloseParen; break;
            case '[': kind = TokenKind::OpenBracket; break;
            case ']': kind = TokenKind::CloseBracket; break;
            default: break;
        }
        tokens.push_back({kind, std::string(1, ch), line, column_at(pos)});
        ++pos;
    }

    return tokens;
}

}  // namespace codecraft
