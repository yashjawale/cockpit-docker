/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Confirmation dialog for pruning unused images across all owners.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Checkbox } from "@patternfly/react-core/dist/esm/components/Checkbox";
import { List, ListItem } from "@patternfly/react-core/dist/esm/components/List";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { Flex } from "@patternfly/react-core/dist/esm/layouts/Flex";

import cockpit from 'cockpit';

import * as client from '../lib/client.ts';
import { image_name } from '../lib/util.ts';

import type { DockerError, DockerImage, Notification, User } from '../lib/types.ts';

import "@patternfly/patternfly/utilities/Spacing/spacing.css";

const _ = cockpit.gettext;

/** A collapsible list of the unused images belonging to one user */
const ImageOptions = ({ images, checked, user, handleChange, name, showCheckbox }: {
    images: DockerImage[],
    checked: boolean,
    user: User,
    handleChange: (val: boolean) => void,
    name: string,
    showCheckbox: boolean,
}) => {
    const [isExpanded, onToggle] = useState(false);
    let shownImages = images;
    if (!isExpanded) {
        shownImages = shownImages.slice(0, 5);
    }

    if (shownImages.length === 0) {
        return null;
    }
    const listNameId = `list-${name}`;

    return (
        <Flex direction={{ default: 'column' }}>
            {showCheckbox &&
                <Checkbox
                    label={user.uid === 0
                        ? _("Delete unused system images:")
                        : cockpit.format(_("Delete unused images of user $0:"), user.name)}
                    isChecked={checked}
                    id={name}
                    name={name}
                    onChange={(_, val) => handleChange(val)}
                    aria-owns={listNameId}
                />}
            <List id={listNameId}>
                {shownImages.map((image, index) =>
                    <ListItem className="pf-v6-u-ml-md" key={index}>
                        {image_name(image)}
                    </ListItem>
                )}
                {!isExpanded && images.length > 5 &&
                <Button onClick={() => onToggle(!isExpanded)} variant="link" isInline>
                    {_("Show more")}
                </Button>}
            </List>
        </Flex>
    );
};

/**
 * Modal that deletes all unused images, grouped by their owning user.
 */
const PruneUnusedImagesModal = ({ close, unusedImages, onAddNotification, users }: {
    close: () => void,
    unusedImages: DockerImage[],
    onAddNotification: (notification: Notification) => void,
    users: User[],
}) => {
    const unusedOwners = users.filter(user => unusedImages.some(image => image.uid === user.uid));
    const [isPruning, setPruning] = useState(false);
    const [deleteOwners, setDeleteOwners] = useState(unusedOwners);

    /**
     * Prune the unused images of every selected owner in parallel.
     *
     * Closes the dialog on success, and reports a notification plus closes on
     * failure.
     */
    const handlePruneUnusedImages = () => {
        setPruning(true);

        const actions = deleteOwners.map(owner => client.pruneUnusedImages(owner.con as NonNullable<User["con"]>));
        Promise.allSettled(actions).then(results => {
            const failures = results
                    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
                    .map(result => (result.reason as DockerError).message);
            if (failures.length > 0) {
                const error = _("Failed to prune unused images");
                onAddNotification({ type: 'danger', error, errorDetail: failures.join("\n") });
            }
            close();
        });
    };

    const showCheckboxes = unusedOwners.length > 1;

    /**
     * Add or remove an owner from the set whose images will be pruned.
     *
     * @param user    The owner whose checkbox changed
     * @param checked Whether the owner is now selected
     */
    const onCheckChange = (user: User, checked: boolean) => setDeleteOwners(prevState => {
        return checked ? prevState.concat([user]) : prevState.filter(u => u !== user);
    });

    return (
        <Modal
            isOpen
            onClose={close}
            position="top"
            variant="medium"
        >
            <ModalHeader title={cockpit.format(_("Prune unused images"))} />
            <ModalBody>
                <Flex direction={{ default: 'column' }}>
                    {unusedOwners.map(user => (
                        <ImageOptions
                            key={user.name}
                            images={unusedImages.filter(image => image.uid === user.uid)}
                            name={`deleteImages-${user.name}`}
                            checked={deleteOwners.some(u => u.uid === user.uid)}
                            handleChange={checked => onCheckChange(user, checked)}
                            showCheckbox={showCheckboxes}
                            user={user}
                        />
                    ))}
                </Flex>
            </ModalBody>
            <ModalFooter>
                <Button
                    id="btn-img-delete"
                    variant="danger"
                    {...(isPruning ? { spinnerAriaValueText: _("Pruning images") } : {})}
                    isLoading={isPruning}
                    isDisabled={deleteOwners.length === 0}
                    onClick={handlePruneUnusedImages}
                >
                    {isPruning ? _("Pruning images") : _("Prune")}
                </Button>
                <Button variant="link" onClick={() => close()}>{_("Cancel")}</Button>
            </ModalFooter>
        </Modal>
    );
};

export default PruneUnusedImagesModal;
