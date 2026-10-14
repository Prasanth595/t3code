// The third-party modules linked artifacts may import, keyed by specifier. Imported from a file under
// src/ so bundle() resolves them from the checkout, the same single copy every block uses.
import * as react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as reactDom from "react-dom";
import * as reactDomClient from "react-dom/client";
import * as tabler from "@tabler/icons-react";
import * as motion from "motion";
import * as motionReact from "motion/react";
import * as recharts from "recharts";

export default {
  react,
  "react/jsx-runtime": jsxRuntime,
  "react-dom": reactDom,
  "react-dom/client": reactDomClient,
  "@tabler/icons-react": tabler,
  motion,
  "motion/react": motionReact,
  recharts,
};
