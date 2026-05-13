import React from "react";
import { createRoot } from "react-dom/client";
import ShampooLanding from "../App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ShampooLanding />
  </React.StrictMode>,
);
