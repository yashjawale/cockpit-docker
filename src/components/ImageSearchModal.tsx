/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * Dialog to search the registry for images and download them.
 */

import React, { useState } from 'react';

import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Alert } from "@patternfly/react-core/dist/esm/components/Alert";
import { DataList, DataListCell, DataListItem, DataListItemCells, DataListItemRow } from "@patternfly/react-core/dist/esm/components/DataList";
import { Form, FormGroup } from "@patternfly/react-core/dist/esm/components/Form";
import {
    Modal, ModalBody, ModalFooter, ModalHeader
} from '@patternfly/react-core/dist/esm/components/Modal';
import { Radio } from "@patternfly/react-core/dist/esm/components/Radio";
import { TextInput } from "@patternfly/react-core/dist/esm/components/TextInput";
import { ExclamationCircleIcon } from '@patternfly/react-icons';
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { EmptyStatePanel } from "cockpit-components-empty-state.tsx";

import { ErrorNotification } from './Notification.tsx';
import * as client from '../lib/client.ts';

import type { Connection } from '../lib/rest.ts';
import type { ImageSearchResult, User } from '../lib/types.ts';

import './ImageSearchModal.scss';

const _ = cockpit.gettext;

/**
 * Split an image reference into its name and optional tag.
 *
 * Registry ports are preserved, e.g. "localhost:5000/alpine:3.19" splits into
 * the name "localhost:5000/alpine" and the tag "3.19".
 *
 * @param reference The image reference to split
 * @returns The name without a tag, plus the tag or null when none is present
 */
function splitReference(reference: string): { name: string, tag: string | null } {
    const slash = reference.lastIndexOf('/');
    const repoAndTag = slash >= 0 ? reference.slice(slash + 1) : reference;
    const colon = repoAndTag.lastIndexOf(':');
    if (colon > 0)
        return {
            name: reference.slice(0, slash + 1) + repoAndTag.slice(0, colon),
            tag: repoAndTag.slice(colon + 1),
        };
    return { name: reference, tag: null };
}

/**
 * Strip the tag from an image reference, e.g. "alpine:2.6" -> "alpine".
 *
 * Registry ports are kept intact, e.g. "localhost:5000/alpine:3.19" becomes
 * "localhost:5000/alpine", so that a tag chosen in the tag field cannot be
 * duplicated into a reference like "alpine:2.6:latest".
 *
 * @param reference The image reference to clean up
 * @returns The reference without any trailing :tag
 */
function stripImageTag(reference: string): string {
    return splitReference(reference).name;
}

/**
 * Whether the input refers to an image in a registry other than Docker Hub.
 *
 * A registry domain is present when the first path component contains a "."
 * or ":" (a host or host:port) or is "localhost". Docker Hub itself can be
 * searched, so references like "docker.io/foo" are not treated as foreign.
 * Inputs without a slash, such as "alpine" or "myapp:latest", never are.
 *
 * @param input The search input
 * @returns True when the input looks like a non-Docker Hub registry reference
 */
function isOtherRegistry(input: string): boolean {
    if (!input.includes('/'))
        return false;
    const first = input.split('/')[0];
    const foreign = first.includes('.') || first.includes(':') || first === 'localhost';
    return foreign && first !== "docker.io";
}

/**
 * Search the Docker Hub registry for images and download a chosen one.
 *
 * @param downloadImage Callback pulling the selected image for the given user
 * @param users         Possible owners to download the image for
 */
export const ImageSearchModal = ({ downloadImage, users }: {
    downloadImage: (imageName: string, tag: string | null, con: Connection) => void,
    users: User[],
}) => {
    const [searchInProgress, setSearchInProgress] = useState(false);
    const [searchFinished, setSearchFinished] = useState(false);
    const [imageIdentifier, setImageIdentifier] = useState('');
    const [imageList, setImageList] = useState<ImageSearchResult[]>([]);
    const [imageTag, setImageTag] = useState("");
    const [user, setUser] = useState(users[0]);
    const [selected, setSelected] = useState("");
    const [dialogError, setDialogError] = useState("");
    const [dialogErrorDetail, setDialogErrorDetail] = useState("");
    const [typingTimeout, setTypingTimeout] = useState<ReturnType<typeof setTimeout> | null>(null);

    const Dialogs = useDialogs();

    // The Docker daemon searches the default registry (Docker Hub) on our behalf.
    // The current input value is passed in because the imageIdentifier state lags
    // behind the actual input while typing.
    const onSearchTriggered = (value: string, forceSearch = false) => {
        setSearchFinished(false);

        // Do not call the SearchImage API if the input string is not at least 2 chars,
        // unless Enter is pressed, which should force start the search.
        // The comparison was done considering the fact that we miss always one letter due to delayed setState
        if (value.length < 2 && !forceSearch)
            return;

        setSearchInProgress(true);

        const identifier = value.trim();

        // A reference to a registry other than Docker Hub (e.g. "quay.io/org/image:tag")
        // cannot be found through the Docker Hub search; offer it as a direct pull
        // instead and pre-fill the tag from the reference.
        if (isOtherRegistry(identifier)) {
            offerDirectPull(identifier);
            return;
        }

        client.searchImages(user.con as Connection, identifier)
                .then(reply => {
                    setImageList(reply);
                    setSearchInProgress(false);
                    setSearchFinished(true);
                })
                .catch(ex => {
                    setDialogError(_("Failed to search for new images"));
                    setDialogErrorDetail(ex.message ? cockpit.format(_("Failed to search for images: $0"), ex.message) : _("Failed to search for images."));
                    setSearchInProgress(false);
                    setSearchFinished(true);
                });
    };

    // Present a single direct-pull result for the given reference.
    const offerDirectPull = (reference: string) => {
        const { name, tag } = splitReference(reference);
        setImageList([{ name, description: _("Image will be pulled directly from its registry") }]);
        setSelected("0");
        setImageTag(tag ?? "");
        setSearchInProgress(false);
        setSearchFinished(true);
    };

    const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter') {
            // Enter forces an immediate search; the value is not being changed by
            // this key, so currentTarget.value is the full current input.
            e.preventDefault();
            clearTimeout(typingTimeout as ReturnType<typeof setTimeout>);
            onSearchTriggered(e.currentTarget.value, true);
        }
        // Space should not trigger search; all other keys rely on the debounced
        // search scheduled in onChange with the up-to-date value.
    };

    const onToggleUser = (ev: React.SyntheticEvent<HTMLInputElement>) => setUser(users.find(u => u.name === ev.currentTarget.value) || users[0]);
    const onDownloadClicked = () => {
        const selectedImageName = imageList[Number(selected)]?.name;
        if (selectedImageName === undefined)
            return;
        Dialogs.close();
        // The search results may include a tag in the name; strip it so that
        // the separate tag field is the only source of a tag.
        downloadImage(stripImageTag(selectedImageName), imageTag, user.con as Connection);
    };

    const handleClose = () => {
        Dialogs.close();
    };

    return (
        <Modal
            isOpen
            className="docker-search"
            position="top"
            variant="large"
            onClose={handleClose}
        >
            <ModalHeader title={_("Search for an image")} />
            <ModalBody>
                <Form isHorizontal>
                    {dialogError && <ErrorNotification errorMessage={dialogError} errorDetail={dialogErrorDetail} />}
                    {users.length > 1 &&
                        <FormGroup id="as-user" label={_("Owner")} isInline>
                            {users.map(u => (
                                <Radio
                                    name="image-search-modal-owner"
                                    key={u.name}
                                    value={u.name}
                                    label={u.name}
                                    id={`image-search-modal-owner-${u.name}`}
                                    onChange={onToggleUser}
                                    isChecked={u === user}
                                />))}
                        </FormGroup>}
                    <FormGroup fieldId="search-image-dialog-name" label={_("Search for")}>
                        <TextInput
                            id='search-image-dialog-name'
                            type='text'
                            placeholder={_("Search by name or description")}
                            value={imageIdentifier}
                            onKeyDown={onKeyDown}
                            onChange={(_event, value) => {
                                setImageIdentifier(value);
                                // A new search invalidates the previously entered tag.
                                setImageTag("");
                                // An other-registry reference cannot be searched, so update the
                                // direct pull immediately on every change (also covers pasting,
                                // which does not fire onKeyDown).
                                if (isOtherRegistry(value)) {
                                    offerDirectPull(value.trim());
                                    return;
                                }
                                // Reset the timer, to make the http call after 250MS
                                clearTimeout(typingTimeout as ReturnType<typeof setTimeout>);
                                setTypingTimeout(setTimeout(() => onSearchTriggered(value, false), 250));
                            }}
                        />
                    </FormGroup>
                    {isOtherRegistry(imageIdentifier) && (
                        <Alert
                            variant="info"
                            isInline
                            isPlain
                            title={_("Image will be pulled directly from its registry")}
                        >
                            {_("Registries other than Docker Hub cannot be searched; the image is downloaded as-is from the given registry.")}
                        </Alert>
                    )}
                </Form>

                {searchInProgress && <EmptyStatePanel loading title={_("Searching...")} />}

                {!isOtherRegistry(imageIdentifier) && ((!searchInProgress && !searchFinished) || imageIdentifier === "") && <EmptyStatePanel title={_("No images found")} paragraph={_("Start typing to look for images.")} />}

                {searchFinished && imageIdentifier !== '' && (
                    <>
                        {imageList.length === 0 && (
                            <EmptyStatePanel
                                icon={ExclamationCircleIcon}
                                title={cockpit.format(_("No results for $0"), imageIdentifier)}
                                paragraph={_("Retry another term.")}
                            />
                        )}
                        {imageList.length > 0 && (
                            <DataList
                                isCompact
                                aria-label={_("Search results")}
                                selectedDataListItemId={`image-list-item-${selected}`}
                                onSelectDataListItem={(_, key) => {
                                    setSelected(key.split('-').slice(-1)[0]);
                                    // A tag entered for a previous result must not leak into this one.
                                    setImageTag("");
                                }}
                            >
                                {imageList.map((image, iter) => {
                                    return (
                                        <DataListItem id={`image-list-item-${iter}`} key={iter}>
                                            <DataListItemRow>
                                                <DataListItemCells
                                                    dataListCells={[
                                                        <DataListCell key="primary content">
                                                            <span className='image-name'>{image.name}</span>
                                                        </DataListCell>,
                                                        <DataListCell key="secondary content" wrapModifier="truncate">
                                                            <span className='image-description'>{image.description}</span>
                                                        </DataListCell>
                                                    ]}
                                                />
                                            </DataListItemRow>
                                        </DataListItem>
                                    );
                                })}
                            </DataList>
                        )}
                    </>
                )}
            </ModalBody>
            <ModalFooter>
                <Form isHorizontal className="image-search-tag-form">
                    <FormGroup fieldId="image-search-tag" label={_("Tag")}>
                        <TextInput
                            className="image-tag-entry"
                            id="image-search-tag"
                            type='text'
                            placeholder="latest"
                            value={imageTag || ''}
                            onChange={(_event, value) => setImageTag(value)}
                        />
                    </FormGroup>
                </Form>
                <Button variant='primary' isDisabled={selected === ""} onClick={onDownloadClicked}>
                    {_("Download")}
                </Button>
                <Button variant='link' className='btn-cancel' onClick={handleClose}>
                    {_("Cancel")}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
