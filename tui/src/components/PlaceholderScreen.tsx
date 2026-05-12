import React from "react";
import { Box, Text } from "ink";

export function PlaceholderScreen({
  title,
  shipsIn,
}: {
  title: string;
  shipsIn: string;
}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text bold color="cyan">{title}</Text>
      <Text color="gray">Not implemented in this commit — ships in {shipsIn}.</Text>
      <Text color="gray">
        Press <Text color="white">1</Text> to return to Dashboard.
      </Text>
    </Box>
  );
}
