import { describe, expect, it } from "vitest";
import { chromeIntentUrl, detectBrowser, inAppBrowserName } from "./browser.ts";

/** User agents as the apps and browsers send them. */
const UA = {
  xIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.12",
  xIpad:
    "Mozilla/5.0 (iPad; CPU OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPad/11.12",
  xAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 TwitterAndroid",
  instagramIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 339.0.3.12.91 (iPhone15,3; iOS 17_5; en_US; en; scale=3.00; 1290x2796; 615522017)",
  instagramAndroid:
    "Mozilla/5.0 (Linux; Android 13; SM-S911B Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.71 Mobile Safari/537.36 Instagram 339.0.0.32.120 Android (33/13; 480dpi; 1080x2340; samsung; SM-S911B; dm1q; qcom; en_GB; 618200130)",
  threadsIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Barcelona 338.0.0.20.111 (iPhone15,3; iOS 17_5; en_US)",
  facebookIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/618012145;FBDV/iPhone15,3;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/AP2A.240705.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.6478.122 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/473.0.0.43.109;]",
  messengerIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/468.0.0.41.109;FBBV/612311390]",
  linkedinIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [LinkedInApp]/9.30.1630",
  linkedinAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36 [LinkedInApp]/4.1.981",
  line: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.10.0",
  tiktok:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 musical_ly_35.5.0 JsSdk/2.0 NetType/WIFI Channel/App Store ByteLocale/en Region/US",
  snapchat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Snapchat/13.1.0.38 (like Safari/8618.2.12.10.4, panda)",
  wechat:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50(0x1800323c) NetType/WIFI Language/en",
  androidWebView:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0.6668.81 Mobile Safari/537.36",
  iosWebView:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  safariIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  chromeIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.101 Mobile/15E148 Safari/604.1",
  firefoxIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/143.0 Mobile/15E148 Safari/605.1.15",
  googleAppIphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) GSA/385.0.795580548 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",
  samsungAndroid:
    "Mozilla/5.0 (Linux; Android 14; SAMSUNG SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 14; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  ipadSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
  chromeMac:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  firefoxWindows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0",
};

describe("detectBrowser", () => {
  it.each([
    ["xIphone", "X", "ios"],
    ["xIpad", "X", "ios"],
    ["xAndroid", "X", "android"],
    ["instagramIphone", "Instagram", "ios"],
    ["instagramAndroid", "Instagram", "android"],
    ["threadsIphone", "Threads", "ios"],
    ["facebookIphone", "Facebook", "ios"],
    ["facebookAndroid", "Facebook", "android"],
    ["messengerIphone", "Messenger", "ios"],
    ["linkedinIphone", "LinkedIn", "ios"],
    ["linkedinAndroid", "LinkedIn", "android"],
    ["line", "Line", "ios"],
    ["tiktok", "TikTok", "ios"],
    ["snapchat", "Snapchat", "ios"],
    ["wechat", "WeChat", "ios"],
  ] as const)("names the app whose browser it is: %s", (name, app, platform) => {
    expect(detectBrowser(UA[name])).toEqual({ kind: "in-app", app, platform });
  });

  it("knows an app's browser that does not name its app", () => {
    expect(detectBrowser(UA.androidWebView)).toEqual({
      kind: "in-app",
      app: null,
      platform: "android",
    });
    expect(detectBrowser(UA.iosWebView)).toEqual({ kind: "in-app", app: null, platform: "ios" });
  });

  it("takes a web app opened from the Home Screen for Safari, not an app's browser", () => {
    expect(detectBrowser(UA.iosWebView, { standalone: true })).toEqual({
      kind: "phone",
      platform: "ios",
    });
  });

  it.each([
    ["safariIphone", "ios"],
    ["chromeIphone", "ios"],
    ["firefoxIphone", "ios"],
    ["googleAppIphone", "ios"],
    ["chromeAndroid", "android"],
    ["samsungAndroid", "android"],
  ] as const)("takes a phone's own browser for one: %s", (name, platform) => {
    expect(detectBrowser(UA[name])).toEqual({ kind: "phone", platform });
  });

  it.each([
    ["androidTablet", "android"],
    ["ipadSafari", "other"],
    ["chromeMac", "other"],
    ["firefoxWindows", "other"],
    ["", "other"],
  ] as const)("leaves computers and tablets alone: %s", (name, platform) => {
    const userAgent = name === "" ? "" : UA[name];
    expect(detectBrowser(userAgent)).toEqual({ kind: "other", platform });
  });
});

describe("inAppBrowserName", () => {
  it("names the app when it is known", () => {
    expect(inAppBrowserName("X")).toBe("X's in-app browser");
    expect(inAppBrowserName(null)).toBe("This in-app browser");
  });
});

describe("chromeIntentUrl", () => {
  it("opens the same https address in Chrome, and falls back to it", () => {
    expect(chromeIntentUrl("https://appflare.dev/install/glance/?x=1")).toBe(
      "intent://appflare.dev/install/glance/?x=1#Intent;scheme=https;package=com.android.chrome;S.browser_fallback_url=https%3A%2F%2Fappflare.dev%2Finstall%2Fglance%2F%3Fx%3D1;end",
    );
  });

  it("refuses anything but an https address", () => {
    expect(chromeIntentUrl("http://localhost:5173/deploy/")).toBeNull();
    expect(chromeIntentUrl("javascript:alert(1)")).toBeNull();
    expect(chromeIntentUrl("not a url")).toBeNull();
  });
});
