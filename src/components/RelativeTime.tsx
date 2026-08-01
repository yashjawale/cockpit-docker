/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Render a timestamp relative to now, with the absolute time as a tooltip.
 */

import React from 'react';

import { Tooltip } from "@patternfly/react-core/dist/esm/components/Tooltip";
import * as timeformat from 'timeformat';

/**
 * Render a timestamp relative to the current time, with the absolute
 * timestamp available as a tooltip.
 *
 * @param time A Date object or a formatted timestamp string
 */
export const RelativeTime = ({ time }: { time: Date | string | number }) => {
    if (!time)
        return null;
    const timestamp = typeof time === "string" ? Date.parse(time) : time;
    const dateRel = timeformat.distanceToNow(timestamp);
    const dateAbs = timeformat.dateTimeSeconds(timestamp);
    return <Tooltip content={dateAbs}><span>{dateRel}</span></Tooltip>;
};
