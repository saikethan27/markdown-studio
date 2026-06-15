import * as vscode from "vscode";

/**
 * Theme resolution for the preview.
 *
 * The preview ships two built-in themes ("claude", "github"). Users can also
 * define custom themes — each is a blob of global CSS that overrides the design
 * tokens declared in media/theme.css. The active theme id lives in
 * `claudeMarkdownPreview.theme`; custom themes live in
 * `claudeMarkdownPreview.customThemes`.
 */

export interface CustomTheme {
  name: string;
  css: string;
}

export interface ThemeOption {
  id: string;
  label: string;
  builtin: boolean;
}

const BUILTIN_THEMES: readonly ThemeOption[] = [
  { id: "claude", label: "Claude", builtin: true },
  { id: "github", label: "GitHub", builtin: true }
];

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("claudeMarkdownPreview");
}

/** Read and validate the user's custom themes. */
export function getCustomThemes(): CustomTheme[] {
  const raw = config().get<unknown>("customThemes", []);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw.filter(
    (entry): entry is CustomTheme =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as CustomTheme).name === "string" &&
      (entry as CustomTheme).name.trim().length > 0 &&
      typeof (entry as CustomTheme).css === "string"
  );
}

/** The currently selected theme id (built-in id or a custom theme name). */
export function getActiveThemeId(): string {
  return config().get<string>("theme", "claude") || "claude";
}

/**
 * The base body style class for the active theme. Custom themes layer their CSS
 * on top of the "claude" base; only the built-in "github" theme uses the github base.
 */
export function getActiveThemeStyle(): "claude" | "github" {
  return getActiveThemeId() === "github" ? "github" : "claude";
}

/** The override CSS for the active theme — empty for built-ins or unknown ids. */
export function getActiveCustomThemeCss(): string {
  const id = getActiveThemeId();
  if (id === "claude" || id === "github") {
    return "";
  }

  const match = getCustomThemes().find((theme) => theme.name === id);
  return match ? match.css : "";
}

/** All themes available to the dropdown: built-ins first, then user themes. */
export function getThemeOptions(): ThemeOption[] {
  const custom = getCustomThemes().map<ThemeOption>((theme) => ({
    id: theme.name,
    label: theme.name,
    builtin: false
  }));

  return [...BUILTIN_THEMES, ...custom];
}

/** Make a theme active (writes to user/global settings). */
export async function setActiveTheme(id: string): Promise<void> {
  const trimmed = (id ?? "").trim();
  if (!trimmed) {
    return;
  }

  await config().update("theme", trimmed, vscode.ConfigurationTarget.Global);
}

/**
 * Add (or replace by name) a custom theme and make it active. Stored globally so
 * the theme is available across all workspaces.
 */
export async function saveCustomTheme(name: string, css: string): Promise<void> {
  const trimmed = (name ?? "").trim();
  if (!trimmed) {
    return;
  }

  const others = getCustomThemes().filter((theme) => theme.name !== trimmed);
  const next: CustomTheme[] = [...others, { name: trimmed, css: css ?? "" }];

  await config().update("customThemes", next, vscode.ConfigurationTarget.Global);
  await setActiveTheme(trimmed);
}
