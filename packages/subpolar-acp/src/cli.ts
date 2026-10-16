#!/usr/bin/env bun

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { layerStdio } from "./index.ts";

const program = Layer.launch(Layer.provide(layerStdio(), NodeServices.layer));
program.pipe(NodeRuntime.runMain);
