#!/usr/bin/env node
import { runCli } from './program.ts'

process.exitCode = await runCli(process.argv)
