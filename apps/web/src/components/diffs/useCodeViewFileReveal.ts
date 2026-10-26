import type { CodeViewScrollTarget } from "@pierre/diffs";
import { useEffect, useRef, useState } from "react";

interface FileRevealHandle {
  getInstance(): object | undefined;
  scrollTo(target: CodeViewScrollTarget): void;
}

export function useCodeViewFileReveal<TScope>(
  viewer: FileRevealHandle | null,
  scope: TScope,
  readyFileKeys?: ReadonlyArray<string>,
) {
  const [request, setRequest] = useState<{
    fileKey: string;
    target: CodeViewScrollTarget;
    scope: TScope;
  } | null>(null);
  const handledRequest = useRef<typeof request>(null);

  useEffect(() => {
    if (request === null || handledRequest.current === request) return;
    if (request.scope !== scope) {
      handledRequest.current = request;
      return;
    }
    if (!viewer?.getInstance() || (readyFileKeys && !readyFileKeys.includes(request.fileKey)))
      return;

    viewer.scrollTo(request.target);
    handledRequest.current = request;
  }, [request, scope, viewer, readyFileKeys]);

  return (
    fileKey: string,
    target: CodeViewScrollTarget = { type: "item", id: fileKey, align: "start" },
  ) => setRequest({ fileKey, target, scope });
}
