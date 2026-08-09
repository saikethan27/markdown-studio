import * as vscode from "vscode";

/**
 * Theme resolution for the preview.
 *
 * A theme has two independent axes:
 *
 *   1. Theme style — the design system: "claude", "github", "ergoread"
 *      (long-form reading) or "executive" (presentation). Stored in
 *      `claudeMarkdownPreview.theme`, which may also hold the name of a user
 *      theme from `claudeMarkdownPreview.customThemes`.
 *   2. Surface palette — for the design systems that ship more than one set of
 *      surface colours, which one is active. Typography, spacing and accents are
 *      identical across a system's palettes; only the surface hue changes.
 *      Stored per style in `claudeMarkdownPreview.surfacePalettes` so switching
 *      themes remembers each one's palette.
 *
 * Both axes become body classes: `theme-style-<style>` and
 * `theme-palette-<palette>`, which media/theme.css keys its token blocks off.
 */

export type ThemeStyle = "claude" | "github" | "ergoread" | "executive";

export interface CustomTheme {
  name: string;
  css: string;
}

export interface ThemeOption {
  id: string;
  label: string;
  builtin: boolean;
}

export interface PaletteOption {
  id: string;
  label: string;
  description: string;
}

const BUILTIN_THEMES: readonly ThemeOption[] = [
  { id: "claude", label: "Claude", builtin: true },
  { id: "github", label: "GitHub", builtin: true },
  { id: "ergoread", label: "ErgoRead — reading", builtin: true },
  { id: "executive", label: "Executive — presentation", builtin: true }
];

const BUILTIN_STYLES: readonly ThemeStyle[] = ["claude", "github", "ergoread", "executive"];

/**
 * Surface palettes per style. Claude and GitHub ship a single fixed palette, so
 * they have none — the palette control hides for them.
 */
const PALETTES: Readonly<Record<ThemeStyle, readonly PaletteOption[]>> = {
  claude: [],
  github: [],
  ergoread: [
    { id: "warm", label: "Warm Ash", description: "Paper-like warm charcoal. Softest at night." },
    { id: "cool", label: "Cool Slate", description: "Cool blue-grey; sits naturally beside VS Code's chrome." },
    { id: "neutral", label: "Graphite", description: "Near-neutral; accents read at full strength." },
    { id: "cursor", label: "Cursor", description: "Pure neutral greys, raised code blocks." }
  ],
  executive: [
    { id: "slate", label: "Slate", description: "Cool and crisp; boardroom default." },
    { id: "graphite", label: "Graphite", description: "Neutral-warm; reads editorial rather than dashboard." }
  ]
};

const DEFAULT_PALETTES: Readonly<Record<ThemeStyle, string>> = {
  claude: "",
  github: "",
  ergoread: "warm",
  executive: "slate"
};

function config(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("claudeMarkdownPreview");
}

function isThemeStyle(value: string): value is ThemeStyle {
  return (BUILTIN_STYLES as readonly string[]).includes(value);
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
 * The base body style for the active theme. Custom themes layer their CSS on top
 * of the "claude" base, so anything unrecognised resolves there.
 */
export function getActiveThemeStyle(): ThemeStyle {
  const id = getActiveThemeId();
  return isThemeStyle(id) ? id : "claude";
}

/** The override CSS for the active theme — empty for built-ins or unknown ids. */
export function getActiveCustomThemeCss(): string {
  const id = getActiveThemeId();
  if (isThemeStyle(id)) {
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

/** Surface palettes offered by a style — empty when the style has only one. */
export function getPaletteOptions(style: ThemeStyle = getActiveThemeStyle()): PaletteOption[] {
  return [...PALETTES[style]];
}

/**
 * The active surface palette for a style. Returns "" when the style has no
 * palettes, and falls back to the style's default when the stored value is
 * missing or no longer valid.
 */
export function getActivePalette(style: ThemeStyle = getActiveThemeStyle()): string {
  const options = PALETTES[style];
  if (options.length === 0) {
    return "";
  }

  const stored = config().get<Record<string, unknown>>("surfacePalettes", {});
  const candidate = stored && typeof stored === "object" ? stored[style] : undefined;

  if (typeof candidate === "string" && options.some((option) => option.id === candidate)) {
    return candidate;
  }

  return DEFAULT_PALETTES[style];
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
 * Set the surface palette for a style. Stored per style so each design system
 * keeps its own choice as the user switches between them. Ignores palettes the
 * style does not offer.
 */
export async function setActivePalette(
  paletteId: string,
  style: ThemeStyle = getActiveThemeStyle()
): Promise<void> {
  const trimmed = (paletteId ?? "").trim();
  if (!trimmed || !PALETTES[style].some((option) => option.id === trimmed)) {
    return;
  }

  const stored = config().get<Record<string, unknown>>("surfacePalettes", {});
  const next = { ...(stored && typeof stored === "object" ? stored : {}), [style]: trimmed };

  await config().update("surfacePalettes", next, vscode.ConfigurationTarget.Global);
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
