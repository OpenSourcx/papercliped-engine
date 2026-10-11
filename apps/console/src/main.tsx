import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App.tsx";
import { SessionProvider } from "./auth/session.tsx";
import { EngineProvider } from "./data/store.tsx";
import { PinProvider } from "./pin/PinContext.tsx";
import { ThemeProvider } from "./theme/theme.tsx";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <SessionProvider>
        <EngineProvider>
          <BrowserRouter>
            <PinProvider>
              <App />
            </PinProvider>
          </BrowserRouter>
        </EngineProvider>
      </SessionProvider>
    </ThemeProvider>
  </StrictMode>,
);
