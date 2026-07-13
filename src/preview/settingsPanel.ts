/**
 * Markup for the right-side settings panel and the "Add new theme" modal, shared
 * by both webview hosts (PreviewPanel and the custom editor). All dynamic state —
 * the default-editor toggle, the theme dropdown options, and the active selection —
 * is hydrated at runtime by media/preview.js from the `settingsState` message.
 *
 * SETTINGS_PANEL_HTML is injected inside the body row; THEME_MODAL_HTML is injected
 * at the top level so the pop-up overlays the whole view.
 */

// Worked example shown in the "Add new theme" modal. Avoid < and > so it renders
// verbatim inside <pre><code> without HTML escaping.
const EXAMPLE_THEME_CSS = `/* A theme is global CSS that overrides design tokens. */
/* Layout, type & spacing apply to both light and dark: */
:root {
  --content-max-width: 860px;
  --font-sans: "Inter", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --radius: 0.75rem;
}

/* Light-mode colors: */
body.theme-light {
  --background: #faf7ff;
  --foreground: #2a2333;
  --card: #ffffff;
  --primary: #7c3aed;
  --border: #e4d9f5;
  --hl-keyword: #7c3aed;
  --hl-string: #1a7f37;
  --hl-comment: #9b8fb0;
}

/* Dark-mode colors: */
body.theme-dark {
  --background: #160f22;
  --foreground: #e8e0f5;
  --card: #1d1430;
  --primary: #a78bfa;
  --border: #2e2440;
  --hl-keyword: #c4b5fd;
  --hl-string: #7ee787;
  --hl-comment: #8a7ca8;
}`;

export const SETTINGS_PANEL_HTML = `<aside class="settings-sidebar" id="settingsSidebar" aria-label="markdown-studio settings" aria-hidden="true">
        <div class="settings-panel-header">
          <span class="settings-panel-title">Settings</span>
          <button class="settings-close" id="settingsClose" type="button" title="Close settings" aria-label="Close settings">&times;</button>
        </div>
        <div class="settings-panel-body">
          <div class="setting-item">
            <div class="setting-item__text">
              <div class="setting-item__label">Default Markdown editor</div>
              <div class="setting-item__desc">Open <code>.md</code> and <code>.markdown</code> files with markdown-studio automatically instead of the plain text editor.</div>
            </div>
            <button class="setting-switch" id="defaultEditorToggle" type="button" role="switch" aria-checked="false" aria-label="Set markdown-studio as the default Markdown editor">
              <span class="setting-switch__thumb"></span>
            </button>
          </div>

          <div class="setting-separator" role="separator"></div>

          <div class="setting-block">
            <div class="setting-item__label">Theme</div>
            <div class="setting-item__desc">Choose a preview theme, or add your own from custom CSS.</div>
            <select class="setting-select" id="themeSelect" aria-label="Preview theme"></select>
          </div>

          <div class="setting-separator" role="separator"></div>

          <div class="setting-item">
            <div class="setting-item__text">
              <div class="setting-item__label">Show comments</div>
              <div class="setting-item__desc">Render inline review comments (<code>@ms-comment:</code> markers) as bubbles in the preview.</div>
            </div>
            <button class="setting-switch" id="showCommentsToggle" type="button" role="switch" aria-checked="true" aria-label="Show inline comments in the preview">
              <span class="setting-switch__thumb"></span>
            </button>
          </div>

          <div class="setting-item">
            <div class="setting-item__text">
              <div class="setting-item__label">Include comments in export</div>
              <div class="setting-item__desc">Keep comment bubbles when exporting to HTML. Off by default so exports don't leak review notes.</div>
            </div>
            <button class="setting-switch" id="includeCommentsExportToggle" type="button" role="switch" aria-checked="false" aria-label="Include comments when exporting">
              <span class="setting-switch__thumb"></span>
            </button>
          </div>

          <div class="setting-block">
            <label class="setting-item__label" for="commentAuthorInput">Default author name</label>
            <div class="setting-item__desc">Appended to new comments as <code>—Name</code>. Leave empty for no attribution.</div>
            <input class="setting-input" id="commentAuthorInput" type="text" placeholder="e.g. Raj" autocomplete="off" spellcheck="false">
          </div>
        </div>
      </aside>`;

export const THEME_MODAL_HTML = `<div class="theme-modal-overlay" id="themeModalOverlay" role="dialog" aria-modal="true" aria-label="Add new theme" aria-hidden="true">
    <div class="theme-modal">
      <div class="theme-modal__header">
        <span class="theme-modal__title">Add new theme</span>
        <button class="settings-close" id="themeModalClose" type="button" title="Close" aria-label="Close">&times;</button>
      </div>
      <div class="theme-modal__body">
        <label class="setting-field">
          <span class="setting-field__label">Theme name</span>
          <input class="setting-input" id="themeNameInput" type="text" placeholder="My theme" autocomplete="off" spellcheck="false">
        </label>
        <label class="setting-field">
          <span class="setting-field__label">Global CSS schema</span>
          <textarea class="setting-textarea" id="themeCssInput" rows="12" spellcheck="false" placeholder=":root { /* token overrides */ }"></textarea>
        </label>
        <div class="theme-example">
          <div class="theme-example__title">Example &amp; structure</div>
          <p class="setting-item__desc">Override any design token. Put layout, type and spacing tokens under <code>:root</code>, and colors (including <code>--hl-*</code> syntax colors) under <code>body.theme-light</code> / <code>body.theme-dark</code> so they win in each mode.</p>
          <pre class="theme-example__code"><code>${EXAMPLE_THEME_CSS}</code></pre>
        </div>
      </div>
      <div class="theme-modal__footer">
        <button class="ctrl-btn ctrl-btn--primary" id="themeSaveBtn" type="button">Save theme</button>
        <button class="ctrl-btn" id="themeCancelBtn" type="button">Cancel</button>
      </div>
    </div>
  </div>`;
