// CodeCraft Studio - structural analysis, metrics and diagnostics.
//
// Turns a token stream into a scope tree the IDE can render, a set of size and
// complexity metrics, and diagnostics that catch the structural mistakes a
// lexer can see with certainty (unbalanced delimiters, unterminated literals).

#pragma once

#include "codecraft/lexer.hpp"

#include <cstddef>
#include <memory>
#include <ostream>
#include <string>
#include <vector>

namespace codecraft {

struct AstNode {
    std::string kind;   // ProgramRoot, FunctionDeclaration, Block, ...
    std::string name;   // identifier, when one could be recovered
    std::string detail; // the source line that introduced the node, trimmed
    std::size_t line = 1;
    std::size_t end_line = 1;
    std::vector<std::unique_ptr<AstNode>> children;

    AstNode(std::string node_kind, std::string node_name, std::size_t start_line)
        : kind(std::move(node_kind)), name(std::move(node_name)), line(start_line),
          end_line(start_line) {}
};

struct Metrics {
    std::size_t total_lines = 0;
    std::size_t code_lines = 0;
    std::size_t comment_lines = 0;
    std::size_t blank_lines = 0;
    std::size_t characters = 0;
    std::size_t tokens = 0;
    std::size_t declarations = 0;
    std::size_t max_nesting_depth = 0;
    // Branch points plus one: the standard cyclomatic complexity estimate.
    std::size_t cyclomatic_complexity = 1;
};

enum class Severity { Info, Warning, Error };

const char* to_string(Severity severity);

struct Diagnostic {
    Severity severity = Severity::Warning;
    std::string rule;
    std::string message;
    std::size_t line = 1;
    std::size_t column = 1;
};

struct Analysis {
    std::string language;
    std::unique_ptr<AstNode> root;
    Metrics metrics;
    std::vector<Diagnostic> diagnostics;
};

Analysis analyze(const std::string& source, const std::string& language);

// Render the analysis as JSON for the gateway, or as an indented tree for the
// command line.
void write_json(const Analysis& analysis, std::ostream& out);
void write_tree(const AstNode& node, std::ostream& out, int indent = 0);

}  // namespace codecraft
