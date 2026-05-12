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
        <Text><Text color="yellow">1</Text> Dashboard      <Text color="yellow">4</Text> Forecast (c6)</Text>
        <Text><Text color="yellow">2</Text> Tokens         <Text color="yellow">5</Text> Policy   (c6)</Text>
        <Text><Text color="yellow">3</Text> Audit    (c3)  <Text color="yellow">6</Text> Shadow AI (c6)</Text>
      </Box>
      <Box marginTop={1}>
        <Text>
          <Text color="yellow">r</Text> refresh    <Text color="yellow">?</Text> toggle help    <Text color="yellow">q</Text> quit
        </Text>
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text color="gray">Tokens screen:</Text>
        <Text>
          <Text color="yellow">↑↓</Text> move  <Text color="yellow">Enter</Text> detail  <Text color="yellow">f</Text> filter  <Text color="yellow">/</Text> search  <Text color="yellow">c</Text> clear  <Text color="yellow">Esc</Text> close
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color="gray">press ? or Esc to dismiss</Text>
      </Box>
    </Box>
  );
}
