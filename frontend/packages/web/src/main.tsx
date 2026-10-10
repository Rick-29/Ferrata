import React from "react"
import ReactDOM from "react-dom/client"
import { APP_FULL_NAME } from "@sqw/brand"
import App from "./App"
import "./index.css"

document.title = APP_FULL_NAME

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
