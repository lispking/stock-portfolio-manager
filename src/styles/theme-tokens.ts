/**
 * Theme-aware color tokens for the application.
 *
 * These tokens provide consistent colors that work in both light and dark themes.
 * Import and use these instead of hardcoded hex colors.
 *
 * For Ant Design components, prefer using the component's built-in token system
 * or semantic color props (like `type="success"`, `type="error"`) when possible.
 */

// Semantic colors that adapt to theme
export const themeColors = {
  // Status colors - use Ant Design's type prop when possible
  success: "var(--color-success, #52c41a)",
  error: "var(--color-error, #ff4d4f)",
  warning: "var(--color-warning, #faad14)",
  info: "var(--color-info, #1677ff)",

  // Text colors
  textPrimary: "var(--color-text, #1f2329)",
  textSecondary: "var(--color-text-secondary, #666)",
  textTertiary: "var(--color-text-tertiary, #999)",

  // Border colors
  borderLight: "var(--color-border, #d9d9d9)",

  // Background colors
  bgElevated: "var(--color-bg-elevated, white)",
} as const;

// CSS variables that get set based on theme
export const themeCssVariables = `
  :root,
  [data-theme="light"] {
    --color-success: #52c41a;
    --color-error: #ff4d4f;
    --color-warning: #faad14;
    --color-info: #1677ff;
    --color-text: #1f2329;
    --color-text-secondary: #666;
    --color-text-tertiary: #999;
    --color-border: #d9d9d9;
    --color-bg-elevated: white;
  }

  [data-theme="dark"] {
    --color-success: #73d13d;
    --color-error: #ff7875;
    --color-warning: #ffc53d;
    --color-info: #4096ff;
    --color-text: #e8e8e8;
    --color-text-secondary: #a6a6a6;
    --color-text-tertiary: #8c8c8c;
    --color-border: #424242;
    --color-bg-elevated: #1f1f1f;
  }
`;
