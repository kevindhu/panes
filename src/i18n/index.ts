import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import commonEn from "./resources/en/common.json";
import appEn from "./resources/en/app.json";
import chatEn from "./resources/en/chat.json";
import workspaceEn from "./resources/en/workspace.json";
import setupEn from "./resources/en/setup.json";
import gitEn from "./resources/en/git.json";
import nativeEn from "./resources/en/native.json";

const resources = {
  en: {
    common: commonEn,
    app: appEn,
    chat: chatEn,
    workspace: workspaceEn,
    setup: setupEn,
    git: gitEn,
    native: nativeEn,
  },
} as const;

let initialized = false;

export async function initializeI18n() {
  if (!initialized) {
    await i18n.use(initReactI18next).init({
      resources,
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      ns: ["common", "app", "chat", "workspace", "setup", "git", "native"],
      interpolation: {
        escapeValue: false,
      },
      returnNull: false,
    });
    initialized = true;
    return i18n;
  }

  await i18n.changeLanguage("en");
  return i18n;
}

export function t(key: string, options?: Record<string, unknown>) {
  return i18n.t(key, options);
}

export { i18n };
