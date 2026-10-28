import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { projectBelongsToWorkspaceArea } from "@t3tools/client-runtime/state/workspace-areas";
import type { WorkspaceArea } from "@t3tools/contracts";
import { LayersIcon } from "lucide-react";

import { useWorkspace } from "../../hooks/useWorkspace";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

type AreaProject = Pick<EnvironmentProject, "id" | "environmentId" | "title">;

export function WorkspaceAreaBreadcrumb({ project }: { readonly project: AreaProject }) {
  const { areas } = useWorkspace();
  return areas.length > 0 ? <AreaBreadcrumb project={project} areas={areas} /> : null;
}

function AreaBreadcrumb({
  project,
  areas,
}: {
  readonly project: AreaProject;
  readonly areas: ReadonlyArray<WorkspaceArea>;
}) {
  const groups = useSidebarProjectGroups();
  const { isMobile, setOpen, setOpenMobile } = useSidebar();
  const ref = { environmentId: project.environmentId, projectId: project.id };
  const group = groups.find((candidate) =>
    projectBelongsToWorkspaceArea({ projectRefs: candidate.memberProjectRefs }, [ref]),
  );
  const matches = areas.filter((area) =>
    projectBelongsToWorkspaceArea(area, group?.memberProjectRefs ?? [ref]),
  );
  if (matches.length === 0) return null;
  const names = matches.map((area) => area.name).join(", ");

  return (
    <>
      <WorkspaceBreadcrumbItem className="shrink">
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label={`Areas for ${project.title}: ${names}`}
                size="xs"
                variant="ghost-muted"
                onClick={() => {
                  if (isMobile) setOpenMobile(true);
                  else setOpen(true);
                }}
              />
            }
          >
            <LayersIcon aria-hidden className="size-3.5" />
            <WorkspaceBreadcrumbText className="max-w-28">
              {matches[0]!.name}
              {matches.length > 1 ? ` +${matches.length - 1}` : ""}
            </WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup>Areas: {names}. Open the sidebar.</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator />
    </>
  );
}
