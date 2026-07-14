// 酒馆 - C++ 消息处理器
// 通过 stdin 接收 JSON 消息，处理后通过 stdout 返回结果
// 与 Node.js 后端通过子进程管道通信
//
// 编译:
//   g++ -O2 -std=c++17 -o message_processor.exe message_processor.cpp
//   或 MSVC: cl /EHsc /O2 message_processor.cpp

#include <iostream>
#include <string>
#include <sstream>
#include <vector>
#include <algorithm>
#include <chrono>
#include <ctime>
#include <unordered_set>
#include <cstdlib>

#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif

// ============================================================
// 敏感词过滤（简单示例实现）
// ============================================================
class SensitiveFilter {
private:
    std::unordered_set<std::string> blocked_words;

public:
    SensitiveFilter() {
        // 示例敏感词列表
        blocked_words = {
            "fuck", "shit", "damn", "ass", " bitch"
        };
    }

    // 检测是否包含敏感词，返回是否通过
    bool check(const std::string& text) const {
        std::string lower = text;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);
        for (const auto& word : blocked_words) {
            if (lower.find(word) != std::string::npos) {
                return false; // 发现敏感词
            }
        }
        return true;
    }

    // 过滤敏感词，替换为 ***
    std::string filter(const std::string& text) const {
        std::string result = text;
        std::string lower = text;
        std::transform(lower.begin(), lower.end(), lower.begin(), ::tolower);

        for (const auto& word : blocked_words) {
            size_t pos = 0;
            std::string lower_word = word;
            std::transform(lower_word.begin(), lower_word.end(), lower_word.begin(), ::tolower);

            while ((pos = lower.find(lower_word, pos)) != std::string::npos) {
                result.replace(pos, word.length(), word.length(), '*');
                lower.replace(pos, lower_word.length(), lower_word.length(), '*');
                pos += word.length();
            }
        }
        return result;
    }
};

// ============================================================
// 消息处理函数
// ============================================================
std::string get_timestamp() {
    auto now = std::chrono::system_clock::now();
    auto in_time_t = std::chrono::system_clock::to_time_t(now);
    auto ms = std::chrono::duration_cast<std::chrono::milliseconds>(
        now.time_since_epoch()) % 1000;

    std::tm bt;
#ifdef _WIN32
    localtime_s(&bt, &in_time_t);
#else
    localtime_r(&in_time_t, &bt);
#endif

    char buf[32];
    std::strftime(buf, sizeof(buf), "%H:%M:%S", &bt);
    char result[48];
    std::snprintf(result, sizeof(result), "%s.%03lld", buf, (long long)ms.count());
    return std::string(result);
}

// URL 解码
std::string url_decode(const std::string& encoded) {
    std::string decoded;
    for (size_t i = 0; i < encoded.length(); ++i) {
        if (encoded[i] == '%' && i + 2 < encoded.length()) {
            int hex_val;
            std::istringstream iss(encoded.substr(i + 1, 2));
            if (iss >> std::hex >> hex_val) {
                decoded += static_cast<char>(hex_val);
                i += 2;
            } else {
                decoded += encoded[i];
            }
        } else if (encoded[i] == '+') {
            decoded += ' ';
        } else {
            decoded += encoded[i];
        }
    }
    return decoded;
}

// 简单的 JSON 编码
std::string json_escape(const std::string& s) {
    std::string escaped;
    for (char c : s) {
        switch (c) {
            case '"': escaped += "\\\""; break;
            case '\\': escaped += "\\\\"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default: escaped += c;
        }
    }
    return escaped;
}

// 处理消息：分析消息长度、生成摘要、过滤敏感词
std::string process_message(const std::string& action,
                            const std::string& content,
                            const std::string& sender) {
    SensitiveFilter filter;

    // 1. 敏感词检查
    bool passed = filter.check(content);
    std::string safe_content = passed ? content : filter.filter(content);

    // 2. 消息统计
    size_t char_count = safe_content.length();
    size_t word_count = 0;
    bool in_word = false;
    for (char c : safe_content) {
        if (std::isspace(c)) {
            in_word = false;
        } else if (!in_word) {
            ++word_count;
            in_word = true;
        }
    }

    // 3. 生成摘要
    std::string summary;
    if (safe_content.length() > 20) {
        summary = safe_content.substr(0, 20) + "...";
    } else {
        summary = safe_content;
    }

    // 4. 构建返回 JSON
    std::ostringstream json;
    json << "{"
         << "\"action\":\"" << json_escape(action) << "\","
         << "\"result\":\"ok\","
         << "\"sender\":\"" << json_escape(sender) << "\","
         << "\"content\":\"" << json_escape(safe_content) << "\","
         << "\"char_count\":" << char_count << ","
         << "\"word_count\":" << word_count << ","
         << "\"summary\":\"" << json_escape(summary) << "\","
         << "\"filtered\":" << (passed ? "false" : "true") << ","
         << "\"timestamp\":\"" << get_timestamp() << "\""
         << "}";

    return json.str();
}

// ============================================================
// 主循环：从 stdin 读取请求，处理后写入 stdout
// 协议：每行一个 JSON 请求，每行一个 JSON 响应
// ============================================================
int main() {
    // 设置 stdin/stdout 为二进制模式 (Windows)
#ifdef _WIN32
    std::ios::sync_with_stdio(false);
    std::cin.tie(nullptr);
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty() || line == "exit") {
            break;
        }

        // 简单的 JSON 解析（不依赖外部库）
        // 提取 action, content, sender 字段
        std::string action = "process";
        std::string content = "";
        std::string sender = "unknown";

        // 非常简单的 JSON 字段提取
        auto extract_field = [](const std::string& json, const std::string& field) -> std::string {
            std::string key = "\"" + field + "\":\"";
            size_t start = json.find(key);
            if (start == std::string::npos) {
                // 尝试不带引号的值（数字/bool）
                std::string key2 = "\"" + field + "\":";
                start = json.find(key2);
                if (start == std::string::npos) return "";
                start += key2.length();
                size_t end = json.find_first_of(",}", start);
                if (end == std::string::npos) return "";
                return json.substr(start, end - start);
            }
            start += key.length();
            size_t end = start;
            while (end < json.length() && json[end] != '"') {
                if (json[end] == '\\') ++end; // skip escaped char
                ++end;
            }
            if (end >= json.length()) return "";
            return json.substr(start, end - start);
        };

        std::string act = extract_field(line, "action");
        if (!act.empty()) action = act;

        std::string cont = extract_field(line, "content");
        if (!cont.empty()) content = url_decode(cont);

        std::string send = extract_field(line, "sender");
        if (!send.empty()) sender = send;

        // 处理消息
        std::string result = process_message(action, content, sender);

        // 输出结果（必须换行）
        std::cout << result << std::endl;

        // 如果收到 exit 命令则退出
        if (action == "exit") break;
    }

    return 0;
}
