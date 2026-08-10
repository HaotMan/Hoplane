import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const savedTheme = window.localStorage.getItem("hoplane.theme");
const initialTheme = savedTheme === "dark" || savedTheme === "light"
  ? savedTheme
  : "light";
document.documentElement.dataset.theme = initialTheme;
document.documentElement.dataset.themePreference = savedTheme === "dark" || savedTheme === "light" ? savedTheme : "light";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
