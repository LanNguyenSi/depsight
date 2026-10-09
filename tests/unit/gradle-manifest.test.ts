import { describe, it, expect, vi } from 'vitest';

import { parseGradleDependencies } from '@/lib/manifests/gradle';
import { collectJavaDeps } from '@/lib/manifests/java';

type Octokit = Parameters<typeof collectJavaDeps>[0];

/**
 * Build a fake octokit whose repos.getContent returns the base64-encoded text
 * for known paths and throws (404) for everything else, mirroring how the
 * GitHub Contents API behaves for missing files.
 */
function octokitWith(files: Record<string, string>): Octokit {
  const getContent = vi.fn(async ({ path }: { path: string }) => {
    if (path in files) {
      return { data: { content: Buffer.from(files[path]).toString('base64') } };
    }
    throw new Error('404');
  });
  return { rest: { repos: { getContent } } } as unknown as Octokit;
}

const coords = (deps: Array<{ groupId: string; artifactId: string; version: string }>) =>
  deps.map((d) => `${d.groupId}:${d.artifactId}:${d.version}`);

describe('parseGradleDependencies', () => {
  it('reads all five configurations in Groovy call form, in source order', () => {
    const body = `dependencies {
  implementation 'org.a:impl:1.0'
  api "org.a:api:2.0"
  compileOnly 'org.a:co:3.0'
  runtimeOnly 'org.a:ro:4.0'
  testImplementation 'org.a:ti:5.0'
}`;
    expect(coords(parseGradleDependencies(body))).toEqual([
      'org.a:impl:1.0',
      'org.a:api:2.0',
      'org.a:co:3.0',
      'org.a:ro:4.0',
      'org.a:ti:5.0',
    ]);
  });

  it('reads Kotlin DSL parenthesised calls', () => {
    const body = `dependencies {
  implementation("org.k:one:1.1")
  api("org.k:two:2.2")
  testImplementation("org.k:three:3.3")
}`;
    expect(coords(parseGradleDependencies(body))).toEqual([
      'org.k:one:1.1',
      'org.k:two:2.2',
      'org.k:three:3.3',
    ]);
  });

  it('reads the Groovy map form', () => {
    const body = "dependencies { implementation group: 'org.m', name: 'groovy-map', version: '1.0' }";
    expect(coords(parseGradleDependencies(body))).toEqual(['org.m:groovy-map:1.0']);
  });

  it('reads the Kotlin map form', () => {
    const body = 'dependencies { implementation(group = "org.m", name = "kotlin-map", version = "2.0") }';
    expect(coords(parseGradleDependencies(body))).toEqual(['org.m:kotlin-map:2.0']);
  });

  it('strips classifier and extension from the coordinate', () => {
    const body = "dependencies { implementation 'org.c:lib:1.2:jdk8@jar' }";
    expect(coords(parseGradleDependencies(body))).toEqual(['org.c:lib:1.2']);
  });

  it.each([
    ['missing version', "implementation 'org.x:noversion'"],
    ['Groovy platform()', "implementation platform('org.x:bom:1.0')"],
    ['Kotlin platform()', 'implementation(platform("org.x:bom:1.0"))'],
    ['$var interpolation', 'implementation "org.x:interp:$ver"'],
    ['${var} interpolation', 'implementation "org.x:interp2:${ver}"'],
    ['version catalog', 'implementation libs.guava'],
    ['version catalog call', 'implementation(libs.versions.x)'],
    ['project dependency', "implementation project(':core')"],
    ['files dependency', "implementation files('libs/a.jar')"],
    ['fileTree dependency', "implementation fileTree(dir: 'libs', include: ['*.jar'])"],
    ['dynamic version 1.+', "implementation 'org.x:dyn:1.+'"],
    ['latest.release', "implementation 'org.x:latest:latest.release'"],
    ['version range', "implementation 'org.x:range:[1.0,2.0)'"],
    ['map form without version', "implementation group: 'org.x', name: 'map-noversion'"],
    ['line comment', "// implementation 'org.x:commented:1.0'"],
    ['block comment', "/* implementation 'org.x:block:1.0' */"],
  ])('skips %s', (_label, body) => {
    expect(parseGradleDependencies(body)).toEqual([]);
  });

  it('handles nested blocks, mixed quoting, trailing comments and URLs', () => {
    const body = `buildscript { dependencies { classpath 'org.b:plugin:1.0' } }
repositories { maven { url 'https://repo.example.com/maven' } }
subprojects { dependencies { implementation "org.s:sub:1.0" } }
implementation 'org.t:top:2.0' // trailing comment`;
    expect(coords(parseGradleDependencies(body))).toEqual(['org.s:sub:1.0', 'org.t:top:2.0']);
  });
});

describe('collectJavaDeps with Gradle files', () => {
  it('parses build.gradle.kts (Kotlin DSL dispatch)', async () => {
    const oct = octokitWith({
      'app/build.gradle.kts': 'dependencies { implementation("org.k:app:1.0") }',
    });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['app/build.gradle.kts']);
    expect(deps).toEqual([{ groupId: 'org.k', artifactId: 'app', version: '1.0' }]);
  });

  it('parses build.gradle (Groovy dispatch)', async () => {
    const oct = octokitWith({
      'build.gradle': "dependencies { implementation 'org.g:root:1.0' }",
    });
    const deps = await collectJavaDeps(oct, 'o', 'r', ['build.gradle']);
    expect(deps).toEqual([{ groupId: 'org.g', artifactId: 'root', version: '1.0' }]);
  });

  it('dedupes pom and Gradle deps with the first-seen path winning', async () => {
    const rootPom = `<project><dependencies>
    <dependency><groupId>org.foo</groupId><artifactId>a</artifactId><version>1.0</version></dependency>
  </dependencies></project>`;
    const modGradle = "dependencies {\n  implementation 'org.foo:a:2.0'\n  implementation 'org.bar:b:3.0'\n}";
    const oct = octokitWith({ 'pom.xml': rootPom, 'mod/build.gradle': modGradle });

    const pomFirst = await collectJavaDeps(oct, 'o', 'r', ['pom.xml', 'mod/build.gradle']);
    const pomFirstVersions = Object.fromEntries(
      pomFirst.map((d) => [`${d.groupId}:${d.artifactId}`, d.version]),
    );
    expect(pomFirstVersions).toEqual({ 'org.foo:a': '1.0', 'org.bar:b': '3.0' });

    const gradleFirst = await collectJavaDeps(oct, 'o', 'r', ['mod/build.gradle', 'pom.xml']);
    const gradleFirstVersions = Object.fromEntries(
      gradleFirst.map((d) => [`${d.groupId}:${d.artifactId}`, d.version]),
    );
    expect(gradleFirstVersions).toEqual({ 'org.foo:a': '2.0', 'org.bar:b': '3.0' });
  });

  it('tries the root Gradle files when no manifest paths are supplied', async () => {
    const oct = octokitWith({
      'build.gradle': "dependencies { implementation 'org.d:default:1.0' }",
    });
    const deps = await collectJavaDeps(oct, 'o', 'r');
    expect(deps).toEqual([{ groupId: 'org.d', artifactId: 'default', version: '1.0' }]);
  });
});
