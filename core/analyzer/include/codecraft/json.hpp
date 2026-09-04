// CodeCraft Studio - minimal JSON writer.
//
// The analyzer emits JSON to the gateway and carries no third-party
// dependencies, so it ships the small amount of serialisation it needs. Only
// writing is implemented; the analyzer never parses JSON.

#pragma once

#include <cstdint>
#include <ostream>
#include <sstream>
#include <string>
#include <vector>

namespace codecraft::json {

// Escape a string into a JSON string literal, including control characters, so
// arbitrary source text survives serialisation.
inline std::string escape(const std::string& input) {
    std::ostringstream out;
    out << '"';
    for (unsigned char ch : input) {
        switch (ch) {
            case '"':  out << "\\\""; break;
            case '\\': out << "\\\\"; break;
            case '\n': out << "\\n";  break;
            case '\r': out << "\\r";  break;
            case '\t': out << "\\t";  break;
            case '\b': out << "\\b";  break;
            case '\f': out << "\\f";  break;
            default:
                if (ch < 0x20 || ch == 0x7f) {
                    static const char* kHex = "0123456789abcdef";
                    out << "\\u00" << kHex[(ch >> 4) & 0xf] << kHex[ch & 0xf];
                } else {
                    out << static_cast<char>(ch);
                }
        }
    }
    out << '"';
    return out.str();
}

// Streaming writer that tracks comma placement so call sites stay readable.
class Writer {
public:
    explicit Writer(std::ostream& out) : out_(out) {}

    void begin_object() { separate(); out_ << '{'; push(); }
    void end_object()   { out_ << '}'; pop(); }
    void begin_array()  { separate(); out_ << '['; push(); }
    void end_array()    { out_ << ']'; pop(); }

    void key(const std::string& name) {
        separate();
        out_ << escape(name) << ':';
        pending_key_ = true;
    }

    void value(const std::string& text) { separate(); out_ << escape(text); }
    void value(const char* text)        { value(std::string(text)); }
    void value(bool flag)               { separate(); out_ << (flag ? "true" : "false"); }
    void value(std::int64_t number)     { separate(); out_ << number; }
    void value(std::size_t number)      { separate(); out_ << number; }
    void value(double number)           { separate(); out_ << number; }
    void null()                         { separate(); out_ << "null"; }

    template <typename T>
    void field(const std::string& name, T&& payload) {
        key(name);
        value(std::forward<T>(payload));
    }

private:
    void push() { first_.push_back(true); }
    void pop()  { if (!first_.empty()) first_.pop_back(); }

    void separate() {
        if (pending_key_) { pending_key_ = false; return; }
        if (first_.empty()) return;
        if (first_.back()) { first_.back() = false; return; }
        out_ << ',';
    }

    std::ostream& out_;
    std::vector<bool> first_;
    bool pending_key_ = false;
};

}  // namespace codecraft::json
