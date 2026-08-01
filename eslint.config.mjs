import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: [
      '**/node_modules',
      '**/dist',
      '**/build',
      '**/out-tsc',
      '**/coverage',
      '**/*.min.js',
    ],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            {
              sourceTag: 'scope:reader-domain',
              onlyDependOnLibsWithTags: ['scope:reader-domain'],
            },
            {
              sourceTag: 'scope:reader-core',
              onlyDependOnLibsWithTags: [
                'scope:reader-core',
                'scope:reader-domain',
              ],
            },
            {
              sourceTag: 'scope:reader-engine',
              onlyDependOnLibsWithTags: [
                'scope:reader-engine',
                'scope:reader-domain',
              ],
            },
            {
              sourceTag: 'scope:library',
              onlyDependOnLibsWithTags: [
                'scope:library',
                'scope:reader-domain',
              ],
            },
            {
              sourceTag: 'scope:sync',
              onlyDependOnLibsWithTags: ['scope:sync', 'scope:reader-domain'],
            },
            {
              sourceTag: 'scope:platform',
              onlyDependOnLibsWithTags: [
                'scope:platform',
                'scope:reader-domain',
              ],
            },
            {
              sourceTag: 'scope:app',
              onlyDependOnLibsWithTags: ['*'],
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      '**/*.ts',
      '**/*.tsx',
      '**/*.cts',
      '**/*.mts',
      '**/*.js',
      '**/*.jsx',
      '**/*.cjs',
      '**/*.mjs',
    ],
    // Override or add rules here
    rules: {},
  },
];
