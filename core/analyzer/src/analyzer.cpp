#include "codecraft/analyzer.hpp"
#include "codecraft/json.hpp"

#include <algorithm>
#include <cctype>
#include <sstream>
#include <vector>

namespace codecraft {
namespace {

/// A long declaration is hard to read; the threshold is a lint heuristic, not a
/// hard rule, so it is reported as a warning rather than an error.
constexpr std::size_t kLongDeclarationLines = 80;
constexpr std::size_t kDeepNestingThreshold = 6;

std::string trim(const std::string& text) {
    const auto begin = text.find_first_not_of(" \t\r\n");
    if (begin == std::string::npos) return {};
    const auto end = text.find_last_not_of(" \t\r\n");
    return text.substr(begin, end - begin + 1);
}

std::vector<std::string> split_lines(const std::string& source) {
    std::vector<std::string> lines;
    if (source.empty()) return lines;

    std::string current;
    for (const char ch : source) {
        if (ch == '\n') {
            lines.push_back(current);
            current.clear();
        } else if (ch != '\r') {
            current.push_back(ch);
        }
    }
    // A trailing newline terminates the last line rather than starting a new
    // empty one, so a file of N lines ending in "\n" counts as N, not N + 1.
    if (!current.empty()) lines.push_back(current);
    return lines;
}

/// Recover the name introduced by a declaration keyword: the first identifier
/// that follows it, skipping the modifiers languages like to stack up front.
std::string recover_name(const std::vector<Token>& tokens, std::size_t keyword_index) {
    for (std::size_t i = keyword_index + 1; i < tokens.size() && i < keyword_index + 8; ++i) {
        const Token& token = tokens[i];
        if (token.kind == TokenKind::Newline) break;
        if (token.kind == TokenKind::Identifier) return token.text;
        // Modifiers and return types may sit between the keyword and the name.
        if (token.kind == TokenKind::Keyword) continue;
        if (token.kind == TokenKind::Operator || token.kind == TokenKind::OpenParen) break;
    }
    return {};
}

std::size_t indentation_width(const std::string& line) {
    std::size_t width = 0;
    for (const char ch : line) {
        if (ch == ' ') ++width;
        else if (ch == '\t') width += 4;  // Match the editor's default tab stop.
        else break;
    }
    return width;
}

}  // namespace

const char* to_string(Severity severity) {
    switch (severity) {
        case Severity::Info:    return "info";
        case Severity::Warning: return "warning";
        case Severity::Error:   return "error";
    }
    return "warning";
}

Analysis analyze(const std::string& source, const std::string& language) {
    const Dialect dialect = dialect_for(language);
    const std::vector<Token> tokens = tokenize(source, dialect);
    const std::vector<std::string> lines = split_lines(source);

    Analysis analysis;
    analysis.language = language;
    analysis.root = std::make_unique<AstNode>("ProgramRoot", "GlobalScope", 1);
    analysis.root->detail = dialect.name;
    analysis.root->end_line = lines.size();

    // ----------------------------------------------------------------- metrics
    Metrics& metrics = analysis.metrics;
    metrics.total_lines = lines.size();
    metrics.characters = source.size();

    std::vector<bool> line_has_code(lines.size() + 2, false);
    std::vector<bool> line_has_comment(lines.size() + 2, false);

    for (const Token& token : tokens) {
        if (token.kind == TokenKind::Newline) continue;
        ++metrics.tokens;
        const std::size_t index = std::min(token.line, lines.size() + 1);
        if (token.kind == TokenKind::Comment) {
            line_has_comment[index] = true;
            // A block comment spans every line it covers.
            const std::size_t span = static_cast<std::size_t>(
                std::count(token.text.begin(), token.text.end(), '\n'));
            for (std::size_t i = 1; i <= span && index + i < line_has_comment.size(); ++i) {
                line_has_comment[index + i] = true;
            }
        } else {
            line_has_code[index] = true;
        }
        if (token.kind == TokenKind::Keyword && dialect.is_branch(token.text)) {
            ++metrics.cyclomatic_complexity;
        }
        if (token.kind == TokenKind::Operator
            && (token.text == "?" )) {
            ++metrics.cyclomatic_complexity;
        }
    }

    for (std::size_t i = 0; i < lines.size(); ++i) {
        const std::size_t line_number = i + 1;
        if (line_has_code[line_number]) {
            ++metrics.code_lines;
        } else if (line_has_comment[line_number]) {
            ++metrics.comment_lines;
        } else if (trim(lines[i]).empty()) {
            ++metrics.blank_lines;
        } else {
            ++metrics.code_lines;
        }
    }

    // Logical "&&"/"||" pairs each add a branch.
    for (std::size_t i = 0; i + 1 < tokens.size(); ++i) {
        if (tokens[i].kind != TokenKind::Operator) continue;
        const bool is_and = tokens[i].text == "&" && tokens[i + 1].text == "&";
        const bool is_or = tokens[i].text == "|" && tokens[i + 1].text == "|";
        if (is_and || is_or) {
            ++metrics.cyclomatic_complexity;
            ++i;  // Consume the pair.
        }
    }

    // ------------------------------------------------------------- scope tree
    std::vector<AstNode*> stack{analysis.root.get()};
    // Tracks, per open brace, whether it belongs to a declaration we pushed.
    std::vector<bool> owns_scope;

    if (dialect.indentation_scoped) {
        // Indentation languages: a declaration owns every following line that is
        // indented further than it.
        std::vector<std::pair<std::size_t, AstNode*>> open_scopes;  // indent, node
        for (std::size_t i = 0; i < lines.size(); ++i) {
            const std::string& raw = lines[i];
            const std::string text = trim(raw);
            if (text.empty()) continue;
            const std::size_t indent = indentation_width(raw);

            while (!open_scopes.empty() && indent <= open_scopes.back().first) {
                open_scopes.back().second->end_line = i;  // previous line
                open_scopes.pop_back();
            }

            std::istringstream words(text);
            std::string first;
            words >> first;
            // "async def" and "pub fn" style prefixes.
            if (first == "async" || first == "pub") {
                std::string second;
                words >> second;
                if (!second.empty()) first = second;
            }
            if (dialect.is_declaration(first)) {
                std::string name;
                words >> name;
                const auto cut = name.find_first_of("(:<[");
                if (cut != std::string::npos) name = name.substr(0, cut);
                const char* kind = (first == "class") ? "ClassDeclaration" : "FunctionDeclaration";
                auto node = std::make_unique<AstNode>(kind, name, i + 1);
                node->detail = text;
                node->end_line = i + 1;
                AstNode* parent =
                    open_scopes.empty() ? analysis.root.get() : open_scopes.back().second;
                AstNode* raw_node = node.get();
                parent->children.push_back(std::move(node));
                open_scopes.emplace_back(indent, raw_node);
                ++metrics.declarations;
                metrics.max_nesting_depth =
                    std::max(metrics.max_nesting_depth, open_scopes.size());
            }
        }
        for (auto& [indent, node] : open_scopes) {
            (void)indent;
            node->end_line = lines.size();
        }
    } else {
        // Brace languages: a declaration keyword arms the next opening brace.
        AstNode* pending = nullptr;
        std::size_t depth = 0;

        for (std::size_t i = 0; i < tokens.size(); ++i) {
            const Token& token = tokens[i];

            if (token.kind == TokenKind::Keyword && dialect.is_declaration(token.text)) {
                const std::string name = recover_name(tokens, i);
                const char* kind = (token.text == "class" || token.text == "struct"
                                    || token.text == "enum" || token.text == "interface"
                                    || token.text == "trait" || token.text == "union")
                                       ? "TypeDeclaration"
                                       : "FunctionDeclaration";
                auto node = std::make_unique<AstNode>(kind, name, token.line);
                node->detail = trim(token.line <= lines.size() ? lines[token.line - 1] : "");
                pending = node.get();
                stack.back()->children.push_back(std::move(node));
                ++metrics.declarations;
                continue;
            }

            if (token.kind == TokenKind::OpenBrace) {
                ++depth;
                metrics.max_nesting_depth = std::max(metrics.max_nesting_depth, depth);
                if (pending != nullptr) {
                    stack.push_back(pending);
                    owns_scope.push_back(true);
                    pending = nullptr;
                } else {
                    owns_scope.push_back(false);
                }
                continue;
            }

            if (token.kind == TokenKind::CloseBrace) {
                if (depth > 0) --depth;
                if (!owns_scope.empty()) {
                    if (owns_scope.back() && stack.size() > 1) {
                        stack.back()->end_line = token.line;
                        stack.pop_back();
                    }
                    owns_scope.pop_back();
                }
                continue;
            }

            // A declaration that never opens a brace (a prototype, an abstract
            // method) ends at its own statement terminator.
            if (pending != nullptr && token.kind == TokenKind::Operator && token.text == ";") {
                pending->end_line = token.line;
                pending = nullptr;
            }
        }
    }

    // ------------------------------------------------------------ diagnostics
    auto& diagnostics = analysis.diagnostics;

    // Delimiter balance, reported at the position of the offending token.
    struct Open { char symbol; std::size_t line; std::size_t column; };
    std::vector<Open> open_delimiters;
    const auto closer_for = [](char symbol) {
        return symbol == '{' ? '}' : (symbol == '(' ? ')' : ']');
    };

    for (const Token& token : tokens) {
        switch (token.kind) {
            case TokenKind::OpenBrace:
                open_delimiters.push_back({'{', token.line, token.column});
                break;
            case TokenKind::OpenParen:
                open_delimiters.push_back({'(', token.line, token.column});
                break;
            case TokenKind::OpenBracket:
                open_delimiters.push_back({'[', token.line, token.column});
                break;
            case TokenKind::CloseBrace:
            case TokenKind::CloseParen:
            case TokenKind::CloseBracket: {
                const char actual = token.text[0];
                if (open_delimiters.empty()) {
                    diagnostics.push_back({Severity::Error, "unbalanced-delimiter",
                                           std::string("Closing '") + actual
                                               + "' has no matching opening delimiter.",
                                           token.line, token.column});
                } else {
                    const char expected = closer_for(open_delimiters.back().symbol);
                    if (expected != actual) {
                        diagnostics.push_back(
                            {Severity::Error, "mismatched-delimiter",
                             std::string("Expected '") + expected + "' to close the '"
                                 + open_delimiters.back().symbol + "' opened on line "
                                 + std::to_string(open_delimiters.back().line) + ", found '"
                                 + actual + "'.",
                             token.line, token.column});
                    }
                    open_delimiters.pop_back();
                }
                break;
            }
            default:
                break;
        }
    }
    for (const Open& open : open_delimiters) {
        diagnostics.push_back({Severity::Error, "unclosed-delimiter",
                               std::string("'") + open.symbol + "' is never closed.", open.line,
                               open.column});
    }

    // Unterminated block comment.
    if (!dialect.block_comment_open.empty() && !tokens.empty()) {
        for (const Token& token : tokens) {
            if (token.kind != TokenKind::Comment) continue;
            if (token.text.rfind(dialect.block_comment_open, 0) != 0) continue;
            const bool closed = token.text.size() >= dialect.block_comment_open.size()
                                                         + dialect.block_comment_close.size()
                                && token.text.compare(
                                       token.text.size() - dialect.block_comment_close.size(),
                                       dialect.block_comment_close.size(),
                                       dialect.block_comment_close)
                                       == 0;
            if (!closed) {
                diagnostics.push_back({Severity::Error, "unterminated-comment",
                                       "Block comment is never closed.", token.line,
                                       token.column});
            }
        }
    }

    // Unterminated string literal: a single-quoted literal that ran into a newline.
    for (const Token& token : tokens) {
        if (token.kind != TokenKind::String || token.text.size() < 1) continue;
        const char quote = token.text.front();
        const bool triple = token.text.size() >= 6 && token.text[1] == quote
                            && token.text[2] == quote;
        const std::size_t minimum = triple ? 6 : 2;
        const bool closed = token.text.size() >= minimum && token.text.back() == quote;
        if (!closed) {
            diagnostics.push_back({Severity::Error, "unterminated-string",
                                   "String literal is never closed.", token.line, token.column});
        }
    }

    if (metrics.max_nesting_depth > kDeepNestingThreshold) {
        diagnostics.push_back({Severity::Warning, "deep-nesting",
                               "Nesting reaches depth " + std::to_string(metrics.max_nesting_depth)
                                   + "; consider extracting inner blocks into functions.",
                               1, 1});
    }

    // Oversized declarations.
    std::vector<const AstNode*> queue{analysis.root.get()};
    while (!queue.empty()) {
        const AstNode* node = queue.back();
        queue.pop_back();
        for (const auto& child : node->children) queue.push_back(child.get());
        if (node->kind == "ProgramRoot") continue;
        if (node->end_line > node->line
            && node->end_line - node->line > kLongDeclarationLines) {
            diagnostics.push_back({Severity::Warning, "long-declaration",
                                   "'" + (node->name.empty() ? node->kind : node->name)
                                       + "' spans " + std::to_string(node->end_line - node->line)
                                       + " lines.",
                                   node->line, 1});
        }
    }

    std::sort(diagnostics.begin(), diagnostics.end(),
              [](const Diagnostic& a, const Diagnostic& b) {
                  if (a.line != b.line) return a.line < b.line;
                  return a.column < b.column;
              });

    return analysis;
}

// ---------------------------------------------------------------- rendering

namespace {

void write_node(const AstNode& node, json::Writer& writer) {
    writer.begin_object();
    writer.field("kind", node.kind);
    writer.field("name", node.name);
    writer.field("detail", node.detail);
    writer.field("line", node.line);
    writer.field("end_line", node.end_line);
    writer.key("children");
    writer.begin_array();
    for (const auto& child : node.children) write_node(*child, writer);
    writer.end_array();
    writer.end_object();
}

}  // namespace

void write_json(const Analysis& analysis, std::ostream& out) {
    json::Writer writer(out);
    writer.begin_object();
    writer.field("language", analysis.language);

    writer.key("metrics");
    writer.begin_object();
    const Metrics& m = analysis.metrics;
    writer.field("total_lines", m.total_lines);
    writer.field("code_lines", m.code_lines);
    writer.field("comment_lines", m.comment_lines);
    writer.field("blank_lines", m.blank_lines);
    writer.field("characters", m.characters);
    writer.field("tokens", m.tokens);
    writer.field("declarations", m.declarations);
    writer.field("max_nesting_depth", m.max_nesting_depth);
    writer.field("cyclomatic_complexity", m.cyclomatic_complexity);
    writer.end_object();

    writer.key("diagnostics");
    writer.begin_array();
    for (const Diagnostic& diagnostic : analysis.diagnostics) {
        writer.begin_object();
        writer.field("severity", std::string(to_string(diagnostic.severity)));
        writer.field("rule", diagnostic.rule);
        writer.field("message", diagnostic.message);
        writer.field("line", diagnostic.line);
        writer.field("column", diagnostic.column);
        writer.end_object();
    }
    writer.end_array();

    writer.key("ast");
    if (analysis.root) {
        write_node(*analysis.root, writer);
    } else {
        writer.null();
    }

    writer.end_object();
    out << '\n';
}

void write_tree(const AstNode& node, std::ostream& out, int indent) {
    for (int i = 0; i < indent; ++i) out << "  ";
    out << (indent == 0 ? "" : "|- ") << node.kind;
    if (!node.name.empty()) out << ": " << node.name;
    out << "  (lines " << node.line << '-' << node.end_line << ")\n";
    for (const auto& child : node.children) write_tree(*child, out, indent + 1);
}

}  // namespace codecraft
