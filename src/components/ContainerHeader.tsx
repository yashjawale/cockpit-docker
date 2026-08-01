/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Toolbar filtering the image list by owner and by a text search.
 */

import React from 'react';

import { FormSelect, FormSelectOption } from "@patternfly/react-core/dist/esm/components/FormSelect";
import { SearchInput } from "@patternfly/react-core/dist/esm/components/SearchInput";
import { Toolbar, ToolbarContent, ToolbarItem } from "@patternfly/react-core/dist/esm/components/Toolbar";

import cockpit from 'cockpit';

import type { User } from '../lib/types.ts';

const _ = cockpit.gettext;

/** Props for the ContainerHeader component */
interface ContainerHeaderProps {
    /** Users that own a Docker daemon, used to populate the owner filter */
    users: User[];
    /** Currently selected owner filter, mirrored from the URL ?owner= option */
    ownerFilter: number | null | "all" | "user";
    /** Called with the raw value of the owner select when it changes */
    handleOwnerChanged: (value: string) => void;
    /** Currently active text search filter */
    textFilter: string;
    /** Called with the new search term when the user types */
    handleFilterChanged: (value: string) => void;
}

/**
 * Toolbar filtering the image list by owner and by a text search.
 *
 * The owner dropdown is only rendered when more than one daemon is available
 * (system and session user). The filter values are mirrored to the URL via
 * the ?owner= and ?name= options by the application.
 */
const ContainerHeader = ({ users, ownerFilter, handleOwnerChanged, textFilter, handleFilterChanged }: ContainerHeaderProps) => {
    return (
        <Toolbar inset={{ sm: 'insetSm', default: 'insetNone' }}>
            <ToolbarContent alignItems='baseline'>
                { users.length >= 2 &&
                    <>
                        <ToolbarItem variant="label">
                            {_("Owner")}
                        </ToolbarItem>
                        <ToolbarItem>
                            <FormSelect
                                id="containers-containers-owner"
                                value={ownerFilter}
                                onChange={(_, value) => handleOwnerChanged(value)}
                            >
                                { users.map(user => (
                                    <FormSelectOption
                                        key={user.name}
                                        value={user.uid === null ? "user" : user.uid}
                                        label={user.name}
                                    />
                                ))}
                                <FormSelectOption value='all' label={_("All")} />
                            </FormSelect>
                        </ToolbarItem>
                    </>}
                <ToolbarItem>
                    <SearchInput
                        id="containers-filter"
                        placeholder={_("Type to filter…")}
                        value={textFilter}
                        onChange={(_, value) => handleFilterChanged(value)}
                        onClear={() => handleFilterChanged('')}
                    />
                </ToolbarItem>
            </ToolbarContent>
        </Toolbar>
    );
};

export default ContainerHeader;
