import { useAtomValue } from "@effect/atom-react";
import type { PullRequestDetail } from "@t3tools/contracts";
import { layoutGitGraph } from "@t3tools/shared/gitGraph";
import { useState } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Path } from "react-native-svg";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { gitEnvironment } from "../../state/git";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { environmentProjects } from "../../state/projects";
import { pullRequestTarget, type PullRequestParams } from "./usePullRequestDiff";

const COLORS = ["#3b82f6", "#10b981", "#8b5cf6", "#f59e0b", "#f43f5e"];

function BranchHistory({
  pr,
  params,
  cwd,
}: {
  pr: PullRequestDetail;
  params: PullRequestParams;
  cwd: string;
}) {
  const { environmentId } = pullRequestTarget(params);
  const query = useEnvironmentQuery(
    gitEnvironment.history({
      environmentId,
      input: { cwd, headBranch: pr.headBranch, baseBranch: pr.baseBranch },
    }),
  );
  const [showAll, setShowAll] = useState(false);
  const graph = layoutGitGraph(query.data?.commits ?? []);
  const rows = showAll ? graph.rows : graph.rows.slice(0, 8);
  if (query.error)
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Retry branch history"
        onPress={query.refresh}
        className="py-3"
      >
        <Text className="text-xs text-foreground-muted">
          Could not load branch history. Tap to retry.
        </Text>
      </Pressable>
    );
  if (query.data === null)
    return (
      <Text accessibilityRole="status" className="py-3 text-xs text-foreground-muted">
        Loading branch history…
      </Text>
    );
  if (rows.length === 0)
    return (
      <Text className="py-3 text-xs text-foreground-muted">
        Check out this branch to see its commit history.
      </Text>
    );
  return (
    <View>
      {rows.map(({ commit, x, color, paths }) => {
        const branch =
          commit.sha === query.data?.headSha
            ? pr.headBranch
            : commit.sha === query.data?.baseSha
              ? pr.baseBranch
              : commit.branches[0];
        return (
          <View
            key={commit.sha}
            className="h-8 flex-row items-center gap-2"
            accessible
            accessibilityLabel={`${commit.subject}, ${commit.author}${branch ? `, ${branch}` : ""}`}
          >
            <Svg
              width={Math.min(graph.width, 80)}
              height={32}
              viewBox={`0 0 ${graph.width} 32`}
              preserveAspectRatio="none"
            >
              {paths.map((path) => (
                <Path
                  key={path.d}
                  d={path.d}
                  stroke={COLORS[path.color]}
                  strokeWidth={1.5}
                  opacity={0.4}
                  fill="none"
                />
              ))}
              <Circle cx={x} cy={16} r={3.5} fill={COLORS[color]} />
            </Svg>
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs">
              {commit.subject || "Untitled commit"}
            </Text>
            {branch ? (
              <View className="max-w-28 shrink rounded bg-accent-soft px-1.5 py-0.5">
                <Text numberOfLines={1} className="font-mono text-2xs text-foreground-muted">
                  {branch}
                </Text>
              </View>
            ) : (
              <Text className="font-mono text-2xs text-foreground-muted">
                {commit.sha.slice(0, 7)}
              </Text>
            )}
          </View>
        );
      })}
      {graph.rows.length > 8 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: showAll }}
          onPress={() => setShowAll(!showAll)}
          className="min-h-10 items-center justify-center active:opacity-70"
        >
          <Text className="text-xs text-foreground-muted">
            {showAll ? "Show less" : `Show ${graph.rows.length - 8} more commits`}
          </Text>
        </Pressable>
      ) : null}
      {showAll && query.data.truncated ? (
        <Text className="text-center text-2xs text-foreground-muted">
          Showing the 40 most recent commits
        </Text>
      ) : null}
    </View>
  );
}

export function PullRequestBranchGraph(props: {
  pr: PullRequestDetail;
  params: PullRequestParams;
}) {
  const { environmentId, input } = pullRequestTarget(props.params);
  const project = useAtomValue(
    environmentProjects.projectAtom({ environmentId, projectId: input.projectId }),
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const [expanded, setExpanded] = useState(false);
  if (config?.environment.capabilities.gitHistory !== true || project === null) return null;
  return (
    <View className="overflow-hidden rounded-xl border border-border/60 px-3">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Local branch history"
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="min-h-11 flex-row items-center gap-2 active:opacity-70"
      >
        <SymbolView name="arrow.triangle.branch" size={14} tintColorClassName="accent-icon-muted" />
        <Text className="flex-1 text-xs font-t3-medium">Local branch history</Text>
        <SymbolView
          name={expanded ? "chevron.down" : "chevron.right"}
          size={10}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {expanded ? (
        <View className="pb-3">
          <BranchHistory {...props} cwd={project.workspaceRoot} />
        </View>
      ) : null}
    </View>
  );
}
