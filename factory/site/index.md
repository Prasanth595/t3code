# t3code factory

t3code factory is a fork of [T3 Code](https://github.com/pingdotgg/t3code/tree/main/docs/user) with a software factory built into its server. You label a GitHub issue `factory:ready`, and the factory claims it, runs an agent session in T3 to build it, runs your project's checks on the result, and leaves a draft pull request that passed them.

This site documents the factory, the part of the fork that upstream T3 Code doesn't have. For T3 Code itself (projects, threads, providers, remote access), read the [T3 Code docs](https://github.com/pingdotgg/t3code/tree/main/docs/user).

- [Guide](/guide/): install the factory, point it at a repo, file work and watch it run.
- [For agents](/agents/): the issue contract, config schemas, run states and scripts, as tables.

The source is on GitHub: [original-solutions/t3code-factory](https://github.com/original-solutions/t3code-factory). The site's own markdown is in `factory/site/`.

The site is also available as plain text for agents: [llms.txt](https://t3code-factory-docs.originalsolutions.com.au/llms.txt) lists every page, and [llms-full.txt](https://t3code-factory-docs.originalsolutions.com.au/llms-full.txt) has all of them in one file.
