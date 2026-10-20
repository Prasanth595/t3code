import { describe, expect, it } from "vite-plus/test";
import {
  initialWorkspaceTabsState,
  workspaceTabsReducer,
  workspaceToolbarHeight,
} from "./workspace-tabs-state";

describe("workspace root navigation", () => {
  it("retains separate queries and positions across tabs, and cancels only the current search", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 640 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 160 });
    state = workspaceTabsReducer(state, { type: "expand" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    expect(state.tabs.pullRequests.query).toBe("");
    state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 240 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "navigation" });
    state = workspaceTabsReducer(state, { type: "select", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({
      query: "keyboard",
      scrollOffset: 160,
      searchMode: "expanded",
    });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      scrollOffset: 640,
      searchMode: "resting",
    });
    expect(state.tabs.pullRequests).toMatchObject({
      query: "navigation",
      scrollOffset: 240,
      searchMode: "active",
    });
  });

  it("clear keeps search active without losing the position cancel restores", () => {
    let state = initialWorkspaceTabsState();
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 500 });
    state = workspaceTabsReducer(state, { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "diff" });
    state = workspaceTabsReducer(state, { type: "scroll", tab: "threads", offset: 80 });
    state = workspaceTabsReducer(state, { type: "query", query: "" });
    state = workspaceTabsReducer(state, { type: "search" });
    expect(state.tabs.threads).toMatchObject({
      query: "",
      searchMode: "active",
      searchEntryOffset: 500,
    });
    expect(workspaceTabsReducer(state, { type: "cancel" }).tabs.threads.scrollOffset).toBe(500);
  });

  it("reserves space for both Android toolbar rows when expanded", () => {
    expect(workspaceToolbarHeight("expanded")).toBeGreaterThan(
      workspaceToolbarHeight("resting") * 2,
    );
  });

  it("a late native blur cannot reopen a cancelled search", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "cancel" });
    expect(workspaceTabsReducer(state, { type: "expand" })).toBe(state);
  });

  it("a blur from the previous native tab cannot open search in the selected tab", () => {
    let state = workspaceTabsReducer(initialWorkspaceTabsState(), { type: "search" });
    state = workspaceTabsReducer(state, { type: "query", query: "keyboard" });
    state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
    state = workspaceTabsReducer(state, { type: "expand", tab: "threads" });
    expect(state.tabs.threads).toMatchObject({ query: "keyboard", searchMode: "expanded" });
    expect(state.tabs.pullRequests.searchMode).toBe("resting");
    expect(workspaceTabsReducer(state, { type: "select", tab: "pullRequests" })).toBe(state);
  });
});

it("keeps issue search and scroll separate through tab switches and late native callbacks", () => {
  let state = initialWorkspaceTabsState();
  state = workspaceTabsReducer(state, { type: "scroll", tab: "pullRequests", offset: 120 });
  state = workspaceTabsReducer(state, { type: "select", tab: "issues" });
  state = workspaceTabsReducer(state, { type: "scroll", tab: "issues", offset: 450 });
  state = workspaceTabsReducer(state, { type: "search" });
  state = workspaceTabsReducer(state, { type: "query", query: "ENG-7" });
  state = workspaceTabsReducer(state, { type: "scroll", tab: "issues", offset: 30 });
  state = workspaceTabsReducer(state, { type: "select", tab: "pullRequests" });
  state = workspaceTabsReducer(state, { type: "expand", tab: "issues" });
  expect(state.tabs.pullRequests).toMatchObject({
    query: "",
    scrollOffset: 120,
    searchMode: "resting",
  });
  state = workspaceTabsReducer(state, { type: "select", tab: "issues" });
  expect(state.tabs.issues).toMatchObject({
    query: "ENG-7",
    scrollOffset: 30,
    searchEntryOffset: 450,
    searchMode: "expanded",
  });
  state = workspaceTabsReducer(state, { type: "cancel" });
  expect(state.tabs.issues).toMatchObject({ query: "", scrollOffset: 450, searchMode: "resting" });
});
