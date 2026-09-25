"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const test_1 = require("@playwright/test");
/**
 * Connects to the pp CDP browser (Vivaldi on pp, forwarded to localhost:9024
 * via ssh LocalForward). Tests drive the real code-server workspace, navigating
 * the nested iframe DOM to reach the preview webview.
 *
 * The tests call `chromium.connectOverCDP()` explicitly (Playwright's config
 * `connectOptions` uses the Playwright websocket protocol, not raw CDP).
 *
 * See docs/important/dev-code-on-nuc-test-on-pp.md for the topology.
 */
exports.default = (0, test_1.defineConfig)({
    testDir: './tests/playwright',
    timeout: 30000,
    expect: { timeout: 10000 },
});
//# sourceMappingURL=playwright.config.js.map