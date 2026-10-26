import { defineConfig } from "@effect/graphql-generator/Config";

// Public schema: https://docs.github.com/public/fpt/schema.docs.graphql. Gate Enterprise-missing fields with @include.
export default defineConfig({
  schema: "./schema/github.graphql",
  documents: ["src/**/*.graphql"],
  scalars: {
    GitObjectID: "effect/Schema#String",
    GitSSHRemote: "effect/Schema#String",
    // A fully qualified ref name such as `refs/heads/main`.
    GitRefname: "effect/Schema#String",
    // Preserve GitHub's strings for comparison with other reads.
    DateTime: "effect/Schema#String",
  },
});
