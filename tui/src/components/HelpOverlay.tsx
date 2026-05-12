import React from "react";
import { Box, Text } from "ink";

// Phase 4.1 c1 — minimal help overlay. Rendered below the main content for
// now (Ink 5 has no portal / true overlay); functionally equivalent because
// the rest of the screen is dimmed by virtue of being above the fold.
//
// c4+ modal stack (mgmt JWT entry, issue/revoke confirmations) will mirror
// this pattern: drawn as the last child of <App/> and given exclusive
// keyboard focus via the parent's useInput gate.
export function HelpOverlay() {
  return (
    <Box
      flexDirection="column"
      borderStyle="double"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginTop={1}
    >
      <Text bold color="cyan">Keybindings</Text>
      <Box flexDirection="column" marginTop={1}>
        <Text><Text color="yellow">1</Text> Dashboard      <Text color="yellow">4</Text> Forecast</Text>
        <Text><Text color="yellow">2</Text> Tokens         <Text color="yellow">5</Text> Policy</Text>
        <Text><Text color="yellow">3</Text> Audit          <Text color="yellow">6</Text> Shadow AI</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="yellow">r</Text> refresh    <Text color="yellow">?</Text> toggle help    <Text color="yellow">q</Text> quit
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Tokens / Audit screens:</Text>
        <Text>
          <Text color="yellow">↑↓</Text> move  <Text color="yellow">Enter</Text> detail  <Text color="yellow">f</Text> filter  <Text color="yellow">/</Text> search  <Text color="yellow">c</Text> clear  <Text color="yellow">Esc</Text> close
        </Text>
        <Text color="gray" dimColor>Tokens: f cycles status  ·  Audit: f cycles outcome</Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Tokens admin (c4):</Text>
        <Text>
          <Text color="yellow">i</Text> issue token  ·  detail panel: <Text color="yellow">x</Text> revoke (<Text color="yellow">y</Text> confirm / <Text color="yellow">n</Text> cancel)
        </Text>
        <Text color="gray" dimColor>
          A `brkm_…` mgmt token is prompted on first admin action and cached for this TUI process only.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Tokens admin (c5a):</Text>
        <Text>
          <Text color="red">R</Text> rotate matched (4-step ceremony)
        </Text>
        <Text color="gray" dimColor>
          filter → preview → dryRun (<Text color="yellow">x</Text> arms · <Text color="yellow">y</Text> fires) → reveal. Lowercase = read, capital = destructive.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Tokens admin (c5b):</Text>
        <Text>
          <Text color="yellow">space</Text> toggle row  ·  <Text color="yellow">a</Text> toggle-all-visible  ·  <Text color="red">X</Text> bulk revoke (when N&gt;0)  ·  <Text color="yellow">Esc</Text> clear selection
        </Text>
        <Text color="gray" dimColor>
          Selection persists across filter/search changes. Revoked rows are not selectable. Bulk revoke runs sequential DELETEs; mid-batch auth abandons rest.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Audit (c6):</Text>
        <Text>
          <Text color="yellow">m</Text> toggle calls ↔ admin actions  ·  <Text color="yellow">t</Text> set mgmt token (admin view, when prompted)
        </Text>
        <Text color="gray" dimColor>
          Admin view requires a brkm_… token (same as Tokens admin). Calls view's `f` cycles outcomes; admin view ignores `f`.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Forecast (c6) / Shadow AI (c6):</Text>
        <Text>
          Forecast: <Text color="yellow">f</Text> cycle tag bucket  ·  <Text color="yellow">r</Text> refresh
        </Text>
        <Text>
          Shadow AI: <Text color="yellow">↑↓</Text> move  ·  <Text color="yellow">Enter</Text> events  ·  <Text color="yellow">r</Text> refresh
        </Text>
        <Text color="gray" dimColor>
          Forecast renders 14-day burn rate as ASCII tables + bars (no charts). Shadow AI groups egress-blocked rows by detector; matched bytes are never logged.
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Policy (c6):</Text>
        <Text>
          <Text color="yellow">r</Text> refresh  ·  read-only (editor is post-4.1)
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">press ? or Esc to dismiss</Text>
      </Box>
    </Box>
  );
}
