import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { EngineProvider } from "./data/store.tsx";
import { PinProvider } from "./pin/PinContext.tsx";
import { ThemeProvider } from "./theme/theme.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <EngineProvider>
        <BrowserRouter>
          <PinProvider>
            <App />
          </PinProvider>
        </BrowserRouter>
      </EngineProvider>
    </ThemeProvider>
  </StrictMode>,
);
