import * as React from "react";
import * as ReactDOM from "react-dom";
import { createRoot } from "react-dom/client";
import fieldImage from "./legacy/assets/7712d5c0-2769-423d-b736-63afa7798caf.png";

declare global {
  interface Window {
    React: typeof React;
    __resources: { fieldImg: string };
  }
}

window.React = React;
window.ReactDOM = Object.assign({}, ReactDOM, { createRoot });
window.__resources = { fieldImg: fieldImage };
