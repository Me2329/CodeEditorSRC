// CodeCraft Studio - analyzer test suite.
//
// Dependency-free assertions so the suite builds anywhere the analyzer builds.

#include "codecraft/analyzer.hpp"
#include "codecraft/json.hpp"

#include <iostream>
#include <sstream>
#include <string>

namespace {

int g_failures = 0;
int g_checks = 0;

void check(bool condition, const std::string& what) {
    ++g_checks;
    if (condition) {
        std::cout << "  pass  " << what << '\n';
    } else {
        ++g_failures;
        std::cout << "  FAIL  " << what << '\n';
    }
}

const codecraft::AstNode* find(const codecraft::AstNode& node, const std::string& name) {
    if (node.name == name) return &node;
    for (const auto& child : node.children) {
        if (const auto* found = find(*child, name)) return found;
    }
    return nullptr;
}

bool has_rule(const codecraft::Analysis& analysis, const std::string& rule) {
    for (const auto& diagnostic : analysis.diagnostics) {
        if (diagnostic.rule == rule) return true;
    }
    return false;
}

void test_cpp_structure() {
    std::cout << "C++ structure\n";
    const std::string source = R"(#include <iostream>

// A greeter.
class Greeter {
public:
    void greet(int times) {
        for (int i = 0; i < times; ++i) {
            if (i % 2 == 0 && i > 0) {
                std::cout << "hi\n";
            }
        }
    }
};

int main() {
    Greeter g;
    g.greet(4);
    return 0;
}
)";
    const auto analysis = codecraft::analyze(source, "cpp");
    check(find(*analysis.root, "Greeter") != nullptr, "recovers the class declaration");
    check(analysis.metrics.declarations >= 1, "counts declarations");
    check(analysis.metrics.comment_lines == 1, "counts comment lines");
    check(analysis.metrics.blank_lines == 2, "counts blank lines");
    check(analysis.metrics.total_lines == 19, "does not count a trailing newline as a line");
    check(analysis.metrics.max_nesting_depth >= 3, "measures nesting depth");
    check(analysis.metrics.cyclomatic_complexity >= 4, "estimates cyclomatic complexity");
    check(analysis.diagnostics.empty(), "reports no diagnostics for valid source");
}

void test_python_structure() {
    std::cout << "Python structure\n";
    const std::string source =
        "import sys\n"
        "\n"
        "\n"
        "class Engine:\n"
        "    def start(self):\n"
        "        if sys.argv:\n"
        "            return True\n"
        "        return False\n"
        "\n"
        "def main():\n"
        "    Engine().start()\n";
    const auto analysis = codecraft::analyze(source, "python");
    const auto* engine = find(*analysis.root, "Engine");
    check(engine != nullptr, "recovers the class");
    check(engine != nullptr && find(*engine, "start") != nullptr,
          "nests the method inside the class");
    check(find(*analysis.root, "main") != nullptr, "recovers a module-level function");
    check(analysis.metrics.declarations == 3, "counts three declarations");
}

void test_delimiter_diagnostics() {
    std::cout << "Delimiter diagnostics\n";
    const auto unclosed = codecraft::analyze("int main() {\n  return 0;\n", "cpp");
    check(has_rule(unclosed, "unclosed-delimiter"), "flags an unclosed brace");

    const auto mismatched = codecraft::analyze("int f() { return (1]; }\n", "cpp");
    check(has_rule(mismatched, "mismatched-delimiter"), "flags a mismatched delimiter");

    const auto extra = codecraft::analyze("int f() { return 0; }}\n", "cpp");
    check(has_rule(extra, "unbalanced-delimiter"), "flags a stray closing brace");

    const auto comment = codecraft::analyze("int f() { /* never closed\n return 0; }\n", "cpp");
    check(has_rule(comment, "unterminated-comment"), "flags an unterminated block comment");

    const auto text = codecraft::analyze("x = \"never closed\ny = 1\n", "python");
    check(has_rule(text, "unterminated-string"), "flags an unterminated string");
}

void test_comments_and_strings_are_not_code() {
    std::cout << "Lexical edge cases\n";
    // Braces inside comments and strings must not affect the scope tree.
    const auto analysis = codecraft::analyze(
        "int main() {\n"
        "    const char* s = \"} not a brace {\";\n"
        "    // } neither is this\n"
        "    return 0;\n"
        "}\n",
        "cpp");
    check(analysis.diagnostics.empty(), "braces inside strings and comments are ignored");

    // A triple-quoted Python string spans lines without terminating.
    const auto docstring = codecraft::analyze(
        "def f():\n"
        "    \"\"\"Doc\n"
        "    continues here\n"
        "    \"\"\"\n"
        "    return 1\n",
        "python");
    check(!has_rule(docstring, "unterminated-string"), "triple-quoted strings span lines");
}

void test_empty_and_binary_input() {
    std::cout << "Robustness\n";
    const auto empty = codecraft::analyze("", "cpp");
    check(empty.root != nullptr, "handles empty input");
    check(empty.metrics.tokens == 0, "reports no tokens for empty input");

    const std::string binary("\x01\x02\x00\xff garbage \x7f", 14);
    const auto noise = codecraft::analyze(binary, "cpp");
    check(noise.root != nullptr, "survives non-source input");
}

void test_json_output_is_well_formed() {
    std::cout << "JSON output\n";
    const auto analysis = codecraft::analyze("int main() { return 0; }\n", "cpp");
    std::ostringstream out;
    codecraft::write_json(analysis, out);
    const std::string text = out.str();

    check(text.front() == '{', "emits a JSON object");
    check(text.find("\"metrics\"") != std::string::npos, "includes metrics");
    check(text.find("\"ast\"") != std::string::npos, "includes the AST");
    check(text.find(",,") == std::string::npos, "contains no doubled commas");
    check(text.find("{,") == std::string::npos && text.find("[,") == std::string::npos,
          "contains no leading commas");

    // Balance check: every brace and bracket outside a string closes.
    int depth = 0;
    bool in_string = false;
    bool escaped = false;
    bool balanced = true;
    for (const char ch : text) {
        if (in_string) {
            if (escaped) escaped = false;
            else if (ch == '\\') escaped = true;
            else if (ch == '"') in_string = false;
            continue;
        }
        if (ch == '"') in_string = true;
        else if (ch == '{' || ch == '[') ++depth;
        else if (ch == '}' || ch == ']') { if (--depth < 0) balanced = false; }
    }
    check(balanced && depth == 0, "brackets are balanced");

    // Control characters in source must be escaped, not emitted raw.
    const auto control = codecraft::analyze("// tab\there\nint x;\n", "cpp");
    std::ostringstream control_out;
    codecraft::write_json(control, control_out);
    const std::string control_text = control_out.str();
    check(control_text.find('\t') == std::string::npos, "escapes control characters");
}

void test_json_escaping() {
    std::cout << "JSON escaping\n";
    check(codecraft::json::escape("a\"b") == "\"a\\\"b\"", "escapes quotes");
    check(codecraft::json::escape("a\\b") == "\"a\\\\b\"", "escapes backslashes");
    check(codecraft::json::escape(std::string("\x01")) == "\"\\u0001\"", "escapes control bytes");
}

}  // namespace

int main() {
    std::cout << "CodeCraft analyzer test suite\n\n";
    test_cpp_structure();
    test_python_structure();
    test_delimiter_diagnostics();
    test_comments_and_strings_are_not_code();
    test_empty_and_binary_input();
    test_json_output_is_well_formed();
    test_json_escaping();

    std::cout << "\n" << (g_checks - g_failures) << '/' << g_checks << " checks passed\n";
    return g_failures == 0 ? 0 : 1;
}
