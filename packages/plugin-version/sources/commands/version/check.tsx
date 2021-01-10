import {WorkspaceRequiredError}                                                                                 from '@yarnpkg/cli';
import {CommandContext, Configuration, MessageName, Project, StreamReport, Workspace, formatUtils, structUtils} from '@yarnpkg/core';
import {ppath}                                                                                                  from '@yarnpkg/fslib';
import {Gem}                                                                                                    from '@yarnpkg/libui/sources/components/Gem';
import {ScrollableItems}                                                                                        from '@yarnpkg/libui/sources/components/ScrollableItems';
import {FocusRequest, FocusRequestHandler, useFocusRequest}                                                     from '@yarnpkg/libui/sources/hooks/useFocusRequest';
import {useListInput}                                                                                           from '@yarnpkg/libui/sources/hooks/useListInput';
import {renderForm}                                                                                             from '@yarnpkg/libui/sources/misc/renderForm';
import {Command, Usage, UsageError}                                                                             from 'clipanion';
import InkTextInput                                                                                             from 'ink-text-input';
import {Box, Text}                                                                                              from 'ink';
import React, {useCallback, useEffect, useState}                                                                from 'react';
import semver                                                                                                   from 'semver';

import * as versionUtils                                                                                        from '../../versionUtils';

type Releases = Map<Workspace, Exclude<versionUtils.Decision, versionUtils.Decision.UNDECIDED>>;

// eslint-disable-next-line arca/no-default-export
export default class VersionCheckCommand extends Command<CommandContext> {
  @Command.Boolean(`-i,--interactive`, {description: `Open an interactive interface used to set version bumps`})
  interactive?: boolean;

  static usage: Usage = Command.Usage({
    category: `Release-related commands`,
    description: `check that all the relevant packages have been bumped`,
    details: `
      **Warning:** This command currently requires Git.

      This command will check that all the packages covered by the files listed in argument have been properly bumped or declined to bump.

      In the case of a bump, the check will also cover transitive packages - meaning that should \`Foo\` be bumped, a package \`Bar\` depending on \`Foo\` will require a decision as to whether \`Bar\` will need to be bumped. This check doesn't cross packages that have declined to bump.

      In case no arguments are passed to the function, the list of modified files will be generated by comparing the HEAD against \`master\`.
    `,
    examples: [[
      `Check whether the modified packages need a bump`,
      `yarn version check`,
    ]],
  });

  @Command.Path(`version`, `check`)
  async execute() {
    if (this.interactive) {
      return await this.executeInteractive();
    } else {
      return await this.executeStandard();
    }
  }

  async executeInteractive() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);

    await project.restoreInstallState();

    const versionFile = await versionUtils.openVersionFile(project);
    if (versionFile === null || versionFile.releaseRoots.size === 0)
      return 0;

    if (versionFile.root === null)
      throw new UsageError(`This command can only be run on Git repositories`);

    const Prompt = () => {
      return (
        <Box flexDirection="row" paddingBottom={1}>
          <Box flexDirection="column" width={60}>
            <Box>
              <Text>
                Press <Text bold color="cyanBright">{`<up>`}</Text>/<Text bold color="cyanBright">{`<down>`}</Text> to select workspaces.
              </Text>
            </Box>
            <Box>
              <Text>
                Press <Text bold color="cyanBright">{`<left>`}</Text>/<Text bold color="cyanBright">{`<right>`}</Text> to select release strategies.
              </Text>
            </Box>
            <Box>
              <Text>
                Press <Text bold color="cyanBright">{`<tab>`}</Text> to move the focus between the sections.
              </Text>
            </Box>
          </Box>
          <Box flexDirection="column">
            <Box marginLeft={1}>
              <Text>
                Press <Text bold color="cyanBright">{`<enter>`}</Text> to save.
              </Text>
            </Box>
            <Box marginLeft={1}>
              <Text>
                Press <Text bold color="cyanBright">{`<ctrl+c>`}</Text> to abort.
              </Text>
            </Box>
          </Box>
        </Box>
      );
    };

    const Undecided = ({workspace, active, decision, setDecision}: {workspace: Workspace, active?: boolean, decision: versionUtils.Decision, setDecision: (decision: versionUtils.Decision) => void}) => {
      const currentVersion = workspace.manifest.version;
      if (currentVersion === null)
        throw new Error(`Assertion failed: The version should have been set (${structUtils.prettyLocator(configuration, workspace.anchoredLocator)})`);

      const strategies: Array<versionUtils.Decision> = semver.prerelease(currentVersion) === null
        ? [versionUtils.Decision.UNDECIDED, versionUtils.Decision.DECLINE, versionUtils.Decision.PATCH, versionUtils.Decision.MINOR, versionUtils.Decision.MAJOR, versionUtils.Decision.PRERELEASE]
        : [versionUtils.Decision.UNDECIDED, versionUtils.Decision.DECLINE, versionUtils.Decision.PRERELEASE, versionUtils.Decision.MAJOR];

      useListInput(decision, strategies, {
        active: active!,
        minus: `left`,
        plus: `right`,
        set: setDecision,
      });

      const nextVersion = decision === versionUtils.Decision.UNDECIDED
        ? <Text color="yellow">{currentVersion}</Text>
        : decision === versionUtils.Decision.DECLINE
          ? <Text color="green">{currentVersion}</Text>
          : <Text><Text color="magenta">{currentVersion}</Text> → <Text color="green">{semver.inc(currentVersion, decision)}</Text></Text>;

      return (
        <Box flexDirection={`column`}>
          <Box>
            <Text>
              {structUtils.prettyLocator(configuration, workspace.anchoredLocator)} - {nextVersion}
            </Text>
          </Box>
          <Box>
            {strategies.map(strategy => {
              const isGemActive = strategy === decision;
              return (
                <Box key={strategy} paddingLeft={2}>
                  <Text>
                    <Gem active={isGemActive} /> {strategy}
                  </Text>
                </Box>
              );
            })}
          </Box>
        </Box>
      );
    };

    const getRelevancy = (releases: Releases) => {
      // Now, starting from all the workspaces that changed, we'll detect
      // which ones are affected by the choices that the user picked. By
      // doing this we'll "forget" all choices that aren't relevant any
      // longer (for example, imagine that the user decided to re-release
      // something, then its dependents, but then decided to not release
      // the original package anymore; then the dependents don't need to
      // released anymore)

      const relevantWorkspaces = new Set(versionFile.releaseRoots);
      const relevantReleases = new Map([...releases].filter(([workspace]) => {
        return relevantWorkspaces.has(workspace);
      }));

      while (true) {
        const undecidedDependentWorkspaces = versionUtils.getUndecidedDependentWorkspaces({
          project: versionFile.project,
          releases: relevantReleases,
        });

        let hasNewDependents = false;

        if (undecidedDependentWorkspaces.length > 0) {
          for (const [workspace] of undecidedDependentWorkspaces) {
            if (!relevantWorkspaces.has(workspace)) {
              relevantWorkspaces.add(workspace);
              hasNewDependents = true;

              const release = releases.get(workspace);
              if (typeof release !== `undefined`) {
                relevantReleases.set(workspace, release);
              }
            }
          }
        }

        if (!hasNewDependents) {
          break;
        }
      }

      return {
        relevantWorkspaces,
        relevantReleases,
      };
    };

    const useReleases = (): [Releases, (workspace: Workspace, decision: versionUtils.Decision) => void] => {
      const [releases, setReleases] = useState<Releases>(() => new Map(versionFile.releases));

      const setWorkspaceRelease = useCallback((workspace: Workspace, decision: versionUtils.Decision) => {
        const copy = new Map(releases);

        if (decision !== versionUtils.Decision.UNDECIDED)
          copy.set(workspace, decision);
        else
          copy.delete(workspace);

        const {relevantReleases} = getRelevancy(copy);
        setReleases(relevantReleases);
      }, [releases, setReleases]);

      return [releases, setWorkspaceRelease];
    };

    const Stats = ({workspaces, releases}: {workspaces: Set<Workspace>, releases: Releases}) => {
      const parts = [];
      parts.push(`${workspaces.size} total`);

      let releaseCount = 0;
      let remainingCount = 0;

      for (const workspace of workspaces) {
        const release = releases.get(workspace);
        if (typeof release === `undefined`) {
          remainingCount += 1;
        } else if (release !== versionUtils.Decision.DECLINE) {
          releaseCount += 1;
        }
      }

      parts.push(`${releaseCount} release${releaseCount === 1 ? `` : `s`}`);
      parts.push(`${remainingCount} remaining`);

      return <Text color="yellow">{parts.join(`, `)}</Text>;
    };

    const ChangeLogInput = ({active = true, onFocusRequest}: {active?: boolean, onFocusRequest?: FocusRequestHandler}) => {
      const [changelogText, setChangelogText] = useState(``);
      const onChangelogTextChange = (val: string) => {
        if (!active) return;
        setChangelogText(val);
      };

      useFocusRequest({
        active: active && !!onFocusRequest,
      }, request => {
        onFocusRequest?.(request);
      }, [
        onFocusRequest,
      ]);

      return (
        <Box flexDirection={`column`} width={`100%`}>
          <Box>
            <Text wrap="wrap">
              Enter a summary for this change (this will be in the changelogs):
            </Text>
          </Box>
          <Box flexDirection={`row`} width={`100%`} marginTop={1}>
            <Box marginTop={1} marginLeft={1} marginRight={1}>
              <Text>
                {active ? <Text color="cyan" bold>{`>`}</Text> : ` `}
              </Text>
            </Box>
            <Box marginLeft={0} borderStyle="round" borderColor={active ? `cyan` : `grey`} paddingY={1} paddingX={2} width={`100%`}>
              <InkTextInput
                value={changelogText}
                onChange={onChangelogTextChange}
                showCursor={active}
                placeholder={` `}
              />
            </Box>
          </Box>
        </Box>
      );
    };

    const App = ({useSubmit}: {useSubmit: (value: Releases) => void}) => {
      const [releases, setWorkspaceRelease] = useReleases();
      useSubmit(releases);

      const {relevantWorkspaces} = getRelevancy(releases);
      const dependentWorkspaces = new Set([...relevantWorkspaces].filter(workspace => {
        return !versionFile.releaseRoots.has(workspace);
      }));

      const focusGroupVisbility = [
        versionFile.releaseRoots.size > 0,  // workspaces version
        dependentWorkspaces.size > 0,       // dependencies version
        versionFile.releaseRoots.size > 0,  // changelog
      ];
      // This would be more elegant once tuple and record is supported so we don't have to
      // workaround React equality check like this
      // See https://github.com/tc39/proposal-record-tuple
      const focusGroupVisbilityMemoString = focusGroupVisbility.map(val => val ? `1` : `0`).join(``);
      const numberOfFocusGroups = focusGroupVisbility.filter(Boolean).length;
      const [focus, setFocus] = useState(0);

      const handleFocusRequest = useCallback((request: FocusRequest) => {
        // due to this constraints, the next/previous focus index will never be -1
        if (numberOfFocusGroups <= 1)
          return;

        switch (request) {
          case FocusRequest.BEFORE: {
            const prevFocusIndex = focusGroupVisbilityMemoString.lastIndexOf(`1`, focus - 1) === -1
              ? focusGroupVisbilityMemoString.lastIndexOf(`1`)
              : focusGroupVisbilityMemoString.lastIndexOf(`1`, focus - 1);
            setFocus(prevFocusIndex);
          } break;
          case FocusRequest.AFTER: {
            const nextFocusIndex = focusGroupVisbilityMemoString.indexOf(`1`, focus + 1) === -1
              ? focusGroupVisbilityMemoString.indexOf(`1`)
              : focusGroupVisbilityMemoString.indexOf(`1`, focus + 1);
            setFocus(nextFocusIndex);
          } break;
        }
      }, [focus, setFocus, focusGroupVisbilityMemoString, numberOfFocusGroups]);

      useEffect(() => {
        if (focusGroupVisbilityMemoString.charAt(focus) !== `1`) {
          if (numberOfFocusGroups > 0) {
            const nextFocusIndex = focusGroupVisbilityMemoString.indexOf(`1`, focus + 1) === -1
              ? focusGroupVisbilityMemoString.indexOf(`1`)
              : focusGroupVisbilityMemoString.indexOf(`1`, focus + 1);
            setFocus(nextFocusIndex);
          }
        }
      }, [focus, focusGroupVisbilityMemoString, numberOfFocusGroups]);

      return (
        <Box flexDirection={`column`}>
          <Prompt />
          <Box>
            <Text wrap="wrap">
              The following files have been modified in your local checkout.
            </Text>
          </Box>
          <Box flexDirection={`column`} marginTop={1} paddingLeft={2}>
            {[...versionFile.changedFiles].map(file => (
              <Box key={file}>
                <Text>
                  <Text color="grey">{versionFile.root}</Text>/{ppath.relative(versionFile.root, file)}
                </Text>
              </Box>
            ))}
          </Box>
          {versionFile.releaseRoots.size > 0 && <>
            <Box marginTop={1}>
              <Text wrap="wrap">
                Because of those files having been modified, the following workspaces may need to be released again (note that private workspaces are also shown here, because even though they won't be published, releasing them will allow us to flag their dependents for potential re-release):
              </Text>
            </Box>
            {dependentWorkspaces.size > 3 ? <Box marginTop={1}>
              <Stats workspaces={versionFile.releaseRoots} releases={releases} />
            </Box> : null}
            <Box marginTop={1} flexDirection={`column`}>
              <ScrollableItems active={focus === 0} radius={1} size={2} onFocusRequest={handleFocusRequest}>
                {[...versionFile.releaseRoots].map(workspace => (
                  <Undecided key={workspace.cwd} workspace={workspace} decision={releases.get(workspace) || versionUtils.Decision.UNDECIDED} setDecision={decision => setWorkspaceRelease(workspace, decision)} />
                ))}
              </ScrollableItems>
            </Box>
          </>}
          {dependentWorkspaces.size > 0 ? (
            <>
              <Box marginTop={1}>
                <Text wrap="wrap">
                  The following workspaces depend on other workspaces that have been marked for release, and thus may need to be released as well:
                </Text>
              </Box>
              {dependentWorkspaces.size > 5 ? (
                <Box marginTop={1}>
                  <Stats workspaces={dependentWorkspaces} releases={releases} />
                </Box>
              ) : null}
              <Box marginTop={1} flexDirection={`column`}>
                <ScrollableItems active={focus === 1} radius={2} size={2} onFocusRequest={handleFocusRequest}>
                  {[...dependentWorkspaces].map(workspace => (
                    <Undecided key={workspace.cwd} workspace={workspace} decision={releases.get(workspace) || versionUtils.Decision.UNDECIDED} setDecision={decision => setWorkspaceRelease(workspace, decision)} />
                  ))}
                </ScrollableItems>
              </Box>
            </>
          ) : null}
          {versionFile.releaseRoots.size > 0 && <>
            <Box marginTop={1} flexDirection={`column`}>
              <ChangeLogInput active={focus === 2} onFocusRequest={handleFocusRequest} />
            </Box>
          </>}
        </Box>
      );
    };

    const decisions = await renderForm<Releases>(App, {versionFile});
    if (typeof decisions === `undefined`)
      return 1;

    versionFile.releases.clear();

    for (const [workspace, decision] of decisions)
      versionFile.releases.set(workspace, decision);

    await versionFile.saveAll();

    return undefined;
  }

  async executeStandard() {
    const configuration = await Configuration.find(this.context.cwd, this.context.plugins);
    const {project, workspace} = await Project.find(configuration, this.context.cwd);

    if (!workspace)
      throw new WorkspaceRequiredError(project.cwd, this.context.cwd);

    await project.restoreInstallState();

    const report = await StreamReport.start({
      configuration,
      stdout: this.context.stdout,
    }, async report => {
      const versionFile = await versionUtils.openVersionFile(project);
      if (versionFile === null || versionFile.releaseRoots.size === 0)
        return;

      if (versionFile.root === null)
        throw new UsageError(`This command can only be run on Git repositories`);

      report.reportInfo(MessageName.UNNAMED, `Your PR was started right after ${formatUtils.pretty(configuration, versionFile.baseHash.slice(0, 7), `yellow`)} ${formatUtils.pretty(configuration, versionFile.baseTitle, `magenta`)}`);

      if (versionFile.changedFiles.size > 0) {
        report.reportInfo(MessageName.UNNAMED, `You have changed the following files since then:`);
        report.reportSeparator();

        for (const file of versionFile.changedFiles) {
          report.reportInfo(null, `${formatUtils.pretty(configuration, versionFile.root, `gray`)}/${ppath.relative(versionFile.root, file)}`);
        }
      }

      let hasDiffErrors = false;
      let hasDepsErrors = false;

      const undecided = versionUtils.getUndecidedWorkspaces(versionFile);

      if (undecided.size > 0) {
        if (!hasDiffErrors)
          report.reportSeparator();

        for (const workspace of undecided)
          report.reportError(MessageName.UNNAMED, `${structUtils.prettyLocator(configuration, workspace.anchoredLocator)} has been modified but doesn't have a release strategy attached`);

        hasDiffErrors = true;
      }

      const undecidedDependents = versionUtils.getUndecidedDependentWorkspaces(versionFile);

      // Then we check which workspaces depend on packages that will be released again but have no release strategies themselves
      for (const [workspace, dependency] of undecidedDependents) {
        if (!hasDepsErrors)
          report.reportSeparator();

        report.reportError(MessageName.UNNAMED, `${structUtils.prettyLocator(configuration, workspace.anchoredLocator)} doesn't have a release strategy attached, but depends on ${structUtils.prettyWorkspace(configuration, dependency)} which is planned for release.`);
        hasDepsErrors = true;
      }

      if (hasDiffErrors || hasDepsErrors) {
        report.reportSeparator();

        report.reportInfo(MessageName.UNNAMED, `This command detected that at least some workspaces have received modifications without explicit instructions as to how they had to be released (if needed).`);
        report.reportInfo(MessageName.UNNAMED, `To correct these errors, run \`yarn version check --interactive\` then follow the instructions.`);
      }
    });

    return report.exitCode();
  }
}
