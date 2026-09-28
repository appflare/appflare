import { RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";
import { getRouter } from "#manager-router";
import "./styles.css";

document.documentElement.dataset.mode = "light";
createRoot(document).render(<RouterProvider router={getRouter()} />);
