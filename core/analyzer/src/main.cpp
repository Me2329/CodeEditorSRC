// CodeCraft Studio - static analyzer command line entry point.
//
// Reads source from a file or standard input and emits either a JSON analysis
// for the gateway or an indented tree for humans.
//
//   codecraft-analyzer --language cpp --file main.cpp
//   cat main.py | codecraft-analyzer --language python --format tree

#include "codecraft/analyzer.hpp"

#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace {

constexpr const char* kVersion = "2.5.0";

void print_usage(std::ostream& out) {
    out << "CodeCraft Studio static analyzer " << kVersion << "\n\n"
        << "Usage: codecraft-analyzer [options]\n\n"
        << "Options:\n"
        << "  --language <id>   Runtime id from the registry (default: cpp)\n"
        << "  --file <path>     Source file to analyze (default: standard input)\n"
        << "  --format <fmt>    json (default) or tree\n"
        << "  --version         Print the version and exit\n"
        << "  --help            Print this message and exit\n";
}

}  // namespace

int main(int argc, char* argv[]) {
    std::string language = "cpp";
    std::string path;
    std::string format = "json";

    for (int i = 1; i < argc; ++i) {
        const std::string arg = argv[i];
        const auto next = [&](const char* name) -> std::string {
            if (i + 1 >= argc) {
                std::cerr << "[analyzer] " << name << " requires a value\n";
                std::exit(64);
            }
            return argv[++i];
        };

        if (arg == "--language" || arg == "-l") {
            language = next("--language");
        } else if (arg == "--file" || arg == "-f") {
            path = next("--file");
        } else if (arg == "--format") {
            format = next("--format");
        } else if (arg == "--version") {
            std::cout << "codecraft-analyzer " << kVersion << '\n';
            return 0;
        } else if (arg == "--help" || arg == "-h") {
            print_usage(std::cout);
            return 0;
        } else {
            std::cerr << "[analyzer] unknown argument '" << arg << "'\n";
            print_usage(std::cerr);
            return 64;
        }
    }

    if (format != "json" && format != "tree") {
        std::cerr << "[analyzer] --format expects 'json' or 'tree'\n";
        return 64;
    }

    std::string source;
    if (path.empty()) {
        std::ostringstream buffer;
        buffer << std::cin.rdbuf();
        source = buffer.str();
    } else {
        std::ifstream input(path, std::ios::binary);
        if (!input) {
            std::cerr << "[analyzer] cannot open '" << path << "'\n";
            return 66;
        }
        std::ostringstream buffer;
        buffer << input.rdbuf();
        source = buffer.str();
    }

    const codecraft::Analysis analysis = codecraft::analyze(source, language);

    if (format == "json") {
        codecraft::write_json(analysis, std::cout);
    } else {
        std::cout << "[CodeCraft AST Static Analyzer " << kVersion << "] language: " << language
                  << '\n';
        if (analysis.root) codecraft::write_tree(*analysis.root, std::cout);
        std::cout << "\nMetrics: " << analysis.metrics.code_lines << " code lines, "
                  << analysis.metrics.declarations << " declarations, complexity "
                  << analysis.metrics.cyclomatic_complexity << ", max nesting "
                  << analysis.metrics.max_nesting_depth << '\n';
        for (const auto& diagnostic : analysis.diagnostics) {
            std::cout << codecraft::to_string(diagnostic.severity) << ' ' << diagnostic.line << ':'
                      << diagnostic.column << "  " << diagnostic.message << " ["
                      << diagnostic.rule << "]\n";
        }
    }

    // A structural error in the source is reported through the payload, not
    // through the exit code: the caller asked for an analysis and got one.
    return 0;
}
