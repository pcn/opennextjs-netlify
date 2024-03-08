import { expect, test, describe, afterEach } from 'vitest'
import { Fixture, fixtureFactories } from '../utils/create-e2e-fixture'

const usedFixtures = new Set<Fixture>()
/**
 * When fixture is used, it is automatically cleanup after test finishes
 */
const selfCleaningFixtureFactories = new Proxy(fixtureFactories, {
  get(target, prop) {
    return async () => {
      const val = target[prop]
      if (typeof val === 'function') {
        const fixture = await val()
        usedFixtures.add(fixture)
        return fixture
      }

      return val
    }
  },
})

afterEach(async () => {
  for (const fixture of usedFixtures) {
    await fixture.cleanup()
  }
  usedFixtures.clear()
})

async function smokeTest(createFixture: () => Promise<Fixture>) {
  const fixture = await createFixture()
  const response = await fetch(fixture.url)
  expect(response.status).toBe(200)

  // remove comments that React injects into produced html
  const body = (await response.text()).replace(/<!--.+-->/g, '')
  await expect(body).toContain('SSR: yes')
}

test('yarn@3 monorepo with pnpm linker', async () => {
  await smokeTest(selfCleaningFixtureFactories.yarnMonorepoWithPnpmLinker)
})

test('npm monorepo deploying from site directory without --filter', async () => {
  await smokeTest(selfCleaningFixtureFactories.npmMonorepoEmptyBaseNoPackagePath)
})

test(
  'npm monorepo creating site workspace as part of build step (no packagePath set) should not deploy',
  { retry: 0 },
  async () => {
    const deployPromise = selfCleaningFixtureFactories.npmMonorepoSiteCreatedAtBuild()

    await expect(deployPromise).rejects.toThrow(
      /Failed creating server handler. BUILD_ID file not found at expected location/,
    )
    await expect(deployPromise).rejects.toThrow(
      /It looks like your site is part of monorepo and Netlify is currently not configured correctly for this case/,
    )
    await expect(deployPromise).rejects.toThrow(/Current package path: <not set>/)
    await expect(deployPromise).rejects.toThrow(/Package path candidates/)
    await expect(deployPromise).rejects.toThrow(/- "apps\/site"/)
    await expect(deployPromise).rejects.toThrow(
      new RegExp('https://docs.netlify.com/configure-builds/monorepos/'),
    )
  },
)

describe('version check', () => {
  test(
    'next@12.0.3 (first version building on recent node versions) should not deploy',
    { retry: 0 },
    async () => {
      // we are not able to get far enough to extract concrete next version, so this error message lack used Next.js version
      await expect(selfCleaningFixtureFactories.next12_0_3()).rejects.toThrow(
        /Your publish directory does not contain expected Next.js build output, please make sure you are using Next.js version \(>=13.5.0\)/,
      )
    },
  )
  test(
    'next@12.1.0 (first version with standalone output supported) should not deploy',
    { retry: 0 },
    async () => {
      await expect(selfCleaningFixtureFactories.next12_1_0()).rejects.toThrow(
        new RegExp(
          `@netlify/plugin-next@5 requires Next.js version >=13.5.0, but found 12.1.0. Please upgrade your project's Next.js version.`,
        ),
      )
    },
  )
  test('yarn monorepo multiple next versions site is compatible', { retry: 0 }, async () => {
    await smokeTest(selfCleaningFixtureFactories.yarnMonorepoMultipleNextVersionsSiteCompatible)
  })

  test(
    'yarn monorepo multiple next versions site is incompatible should not deploy',
    { retry: 0 },
    async () => {
      await expect(
        selfCleaningFixtureFactories.yarnMonorepoMultipleNextVersionsSiteIncompatible(),
      ).rejects.toThrow(
        new RegExp(
          `@netlify/plugin-next@5 requires Next.js version >=13.5.0, but found 13.4.1. Please upgrade your project's Next.js version.`,
        ),
      )
    },
  )

  test(
    'npm nested site multiple next versions site is compatible (currently broken for different reason)',
    { retry: 0 },
    async () => {
      // this should pass version validation, but fails with Error: ENOENT: no such file or directory, open
      // '<fixture_dir>/apps/site/.next/standalone/apps/site/.next/required-server-files.json'
      // while actual location is
      // '<fixture_dir>/apps/site/.next/standalone/.next/required-server-files.json'
      // so this is another case of directories setup that needs to be handled
      await expect(
        selfCleaningFixtureFactories.npmNestedSiteMultipleNextVersionsCompatible(),
      ).rejects.toThrow(
        new RegExp(
          'Failed creating server handler. required-server-files.json file not found at expected location ".+/apps/site/.next/standalone/apps/site/.next/required-server-files.json". Your repository setup is currently not yet supported.',
        ),
      )

      // TODO: above test body should be removed and following line uncommented and test title updated once the issue is fixed
      // await smokeTest(fixtureFactories.npmNestedSiteMultipleNextVersionsCompatible)
    },
  )

  test(
    'npm nested site multiple next versions site is incompatible should not deploy (currently broken for different reason)',
    { retry: 0 },
    async () => {
      // this shouldn't pass version validation, but currently fails before that
      // with Error: ENOENT: no such file or directory, open
      // '<fixture_dir>/apps/site/.next/standalone/apps/site/.next/required-server-files.json'
      // while actual location is
      // '<fixture_dir>/apps/site/.next/standalone/.next/required-server-files.json'
      // so this is another case of directories setup that needs to be handled
      await expect(
        selfCleaningFixtureFactories.npmNestedSiteMultipleNextVersionsIncompatible(),
      ).rejects.toThrow(
        new RegExp(
          'Failed creating server handler. required-server-files.json file not found at expected location ".+/apps/site/.next/standalone/apps/site/.next/required-server-files.json". Your repository setup is currently not yet supported.',
        ),
      )

      // TODO: above test body should be removed and following line uncommented and test title updated once the issue is fixed
      // await expect(
      //   fixtureFactories.npmNestedSiteMultipleNextVersionsIncompatible(),
      // ).rejects.toThrow(
      //   new RegExp(
      //     `@netlify/plugin-next@5 requires Next.js version >=13.5.0, but found 13.4.1. Please upgrade your project's Next.js version.`,
      //   ),
      // )
    },
  )
})
