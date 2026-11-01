#include "gesture_hint.h"

#include <cstring>

namespace {

/* 命中即触发「飞吻」表情的关键词（用户原话或模型回复都可能出现） */
const char *const kKissWords[] = {
    "飞吻", "亲吻", "亲亲", "么么", "啵啵", "吧唧", "吻我", "给我一个吻",
    "送我一个吻", "mua", "Mua", "MUA",
};

bool ContainsAny(const char *text, const char *const *words, size_t count) {
    for (size_t i = 0; i < count; i++) {
        if (strstr(text, words[i]) != nullptr) {
            return true;
        }
    }
    return false;
}

}  // namespace

const char *gesture_hint_from_text(const char *text) {
    if (text == nullptr || text[0] == '\0') {
        return nullptr;
    }
    if (ContainsAny(text, kKissWords, sizeof(kKissWords) / sizeof(kKissWords[0]))) {
        return "kissy";
    }
    return nullptr;
}
