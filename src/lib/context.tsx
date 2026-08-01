/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * React context sharing Docker daemon information across the module.
 */

import React, { useContext } from 'react';

/**
 * Information about the Docker daemon that is shared across the application.
 */
export interface DockerInfo {
    /** Whether SELinux is available on the host */
    selinuxAvailable: boolean;
    /** Version of the Docker daemon */
    version: string;
}

/**
 * React context holding the Docker daemon information.
 *
 * Null while the provider has not been mounted yet, which is why the consumer
 * hook returns a nullable value.
 */
export const DockerInfoContext = React.createContext<DockerInfo | null>(null);

/**
 * Access the shared Docker daemon information.
 */
export const useDockerInfo = () => useContext(DockerInfoContext);

/**
 * Provide Docker daemon information to the whole component tree.
 */
export const WithDockerInfo = ({ value, children }: { value: DockerInfo, children: React.ReactNode }) => {
    return (
        <DockerInfoContext.Provider value={value}>
            {children}
        </DockerInfoContext.Provider>
    );
};
