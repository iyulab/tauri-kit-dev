/**
 * Splits `argv` into flags, options with their values, and positional arguments. An argument
 * starting with `--` that is neither a flag nor an option is an error, so a typo is not silently
 * taken for a path.
 *
 * @param {string[]} argv
 * @param {{ flags?: string[], options?: string[] }} [known]
 */
export function parseArgs(argv, { flags = [], options = [] } = {}) {
  const result = { flags: new Set(), options: {}, positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (flags.includes(arg)) result.flags.add(arg)
    else if (options.includes(arg)) {
      if (i + 1 >= argv.length) throw new Error(`${arg} needs a value`)
      result.options[arg] = argv[++i]
    } else if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`)
    else result.positional.push(arg)
  }
  return result
}
