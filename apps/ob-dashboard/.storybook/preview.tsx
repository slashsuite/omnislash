import type { Preview } from "@storybook/react-vite";
import { useLayoutEffect } from "react";
import "../src/styles.css";

// Dark is the app's only look: Catppuccin Mocha under `.dark` on <html>, which the root document sets
// (src/routes/__root.tsx). Light is kept for checking a component on the light tokens, not as an app look.
const preview: Preview = {
  initialGlobals: { theme: "dark" },
  globalTypes: {
    theme: {
      description: "Theme",
      toolbar: {
        icon: "paintbrush",
        dynamicTitle: true,
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark (Catppuccin)" },
        ],
      },
    },
  },
  decorators: [
    (Story, context) => {
      const dark = context.globals["theme"] === "dark";
      useLayoutEffect(() => {
        document.documentElement.classList.toggle("dark", dark);
        document.body.style.background = dark ? "#181825" : "#f9fafb";
      }, [dark]);
      return (
        <div className="p-4">
          <Story />
        </div>
      );
    },
  ],
};
export default preview;
