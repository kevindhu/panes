import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import commonEn from "./resources/en/common.json";
import chatEn from "./resources/en/codex-chat.json";

let initialized = false;

export async function initializeCodexI18n() {
  if (initialized) {
    return i18n;
  }

  await i18n.use(initReactI18next).init({
    resources: {
      en: {
        common: commonEn,
        chat: chatEn,
      },
    },
    lng: "en",
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common", "chat"],
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });

  initialized = true;
  return i18n;
}
