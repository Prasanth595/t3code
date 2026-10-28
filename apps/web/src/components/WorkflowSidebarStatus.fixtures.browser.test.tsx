import { it } from "vite-plus/test";

import "../index.css";
import { captureSurface } from "../../test/workflow-fixtures/capture";
import { SidebarStatusSurface } from "../../test/workflow-fixtures/surfaces";
import { WORKFLOW_QA_SIDEBAR_STATES } from "../../test/workflow-fixtures/workflowFixtures";

it.each(WORKFLOW_QA_SIDEBAR_STATES)("sidebar status, %s", async (state) => {
  await captureSurface({
    surface: "sidebar-status",
    state,
    // The status badge is production output; the row chrome around it is the fixture's.
    selector: "[data-qa-sidebar] [data-sidebar-top-status]",
    frame: "[data-qa-sidebar]",
    widthIndependent: true,
    element: () => <SidebarStatusSurface state={state} />,
  });
});
