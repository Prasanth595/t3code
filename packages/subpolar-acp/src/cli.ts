#!/usr/bin/env bun

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { createManagedExecutionOptions } from "./managedExecution.ts";
import { layerStdio } from "./index.ts";

const program = Layer.launch(Layer.provide(layerStdio(createManagedExecutionOptions(process.env)), NodeServices.layer));
program.pipe(NodeRuntime.runMain);
