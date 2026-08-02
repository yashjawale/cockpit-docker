/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Health check tab of an expanded container row: the health check
 * configuration and the recent health check runs.
 */

import React from 'react';

import { DescriptionList, DescriptionListDescription, DescriptionListGroup, DescriptionListTerm } from "@patternfly/react-core/dist/esm/components/DescriptionList";
import { Icon } from "@patternfly/react-core/dist/esm/components/Icon";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { CheckCircleIcon, ErrorCircleOIcon } from "@patternfly/react-icons";

import cockpit from 'cockpit';
import { ListingTable } from "cockpit-components-table";

import { quote_cmdline } from '../lib/util.ts';
import { RelativeTime } from './RelativeTime.tsx';

import type { DockerContainer } from '../lib/types.ts';

const _ = cockpit.gettext;

/**
 * Format a duration given in nanoseconds as a human readable amount.
 *
 * @param ns The duration in nanoseconds
 */
const format_nanoseconds = (ns: number) => {
    const seconds = ns / 1000000000;
    return cockpit.format(cockpit.ngettext("$0 second", "$0 seconds", seconds), seconds);
};

/** Props for the Health check tab of a container row */
interface ContainerHealthLogsProps {
    /** The container whose health check is shown */
    container: DockerContainer;
    /** The localized current health state, e.g. "Healthy" */
    state: string;
}

/**
 * The Health check tab of an expanded container row.
 *
 * Shows the health check configuration and the recorded runs; docker runs the
 * configured health check on its own schedule, so no manual trigger exists.
 *
 * @param container The container to show the health check of
 * @param state     The localized current health state
 */
const ContainerHealthLogs = ({ container, state }: ContainerHealthLogsProps) => {
    const healthCheck = container.Config?.Healthcheck ?? {};
    const healthState = container.State?.Health ?? {};
    const logs = [...(healthState.Log || [])].reverse(); // not-covered: Log should always exist, belt-and-suspenders

    return (
        <>
            <Flex alignItems={{ default: "alignItemsFlexStart" }}>
                <FlexItem grow={{ default: 'grow' }}>
                    <DescriptionList isAutoFit id="container-details-healthcheck">
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Status")}</DescriptionListTerm>
                            <DescriptionListDescription>{state}</DescriptionListDescription>
                        </DescriptionListGroup>
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Command")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-command">{quote_cmdline(healthCheck.Test)}</DescriptionListDescription>
                        </DescriptionListGroup>
                        {healthCheck.Interval &&
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Interval")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-interval">{format_nanoseconds(healthCheck.Interval)}</DescriptionListDescription>
                        </DescriptionListGroup>}
                        {healthCheck.Retries &&
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Retries")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-retries">{healthCheck.Retries}</DescriptionListDescription>
                        </DescriptionListGroup>}
                        {healthCheck.StartPeriod &&
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Start period")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-start-period">{format_nanoseconds(healthCheck.StartPeriod)}</DescriptionListDescription>
                        </DescriptionListGroup>}
                        {healthCheck.Timeout &&
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Timeout")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-timeout">{format_nanoseconds(healthCheck.Timeout)}</DescriptionListDescription>
                        </DescriptionListGroup>}
                        {healthState.FailingStreak &&
                        <DescriptionListGroup>
                            <DescriptionListTerm>{_("Failing streak")}</DescriptionListTerm>
                            <DescriptionListDescription className="healthcheck-failing-streak">{healthState.FailingStreak}</DescriptionListDescription>
                        </DescriptionListGroup>}
                    </DescriptionList>
                </FlexItem>
            </Flex>
            <ListingTable
aria-label={_("Logs")}
                          className="health-logs"
                          variant='compact'
                          columns={[_("Last 5 runs"), _("Started at")]}
                          rows={
                              logs.map(log => {
                                  const id = `hc${log.Start}${container.Id}`;
                                  return {
                                      expandedContent: log.Output ? <pre>{log.Output}</pre> : null,
                                      columns: [
                                          {
                                              title:
    <Flex flexWrap={{ default: 'nowrap' }} spaceItems={{ default: 'spaceItemsSm' }} alignItems={{ default: 'alignItemsCenter' }}>
        {log.ExitCode === 0 ? <Icon status="success"><CheckCircleIcon className="green" /></Icon> : <Icon status="danger"><ErrorCircleOIcon className="red" /></Icon>}
        <span>{log.ExitCode === 0 ? _("Passed health run") : _("Failed health run")}</span>
    </Flex>
                                          },
                                          {
                                              title: <RelativeTime time={log.Start ?? ""} />
                                          }
                                      ],
                                      props: {
                                          key: id,
                                          "data-row-id": id,
                                      },
                                  };
                              })
                          }
            />
        </>
    );
};

export default ContainerHealthLogs;
