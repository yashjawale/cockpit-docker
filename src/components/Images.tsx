/*
 * SPDX-License-Identifier: LGPL-2.1-or-later
 *
 * The Images listing card, including download, prune and run actions.
 */

import React, { useState } from 'react';

import { Badge } from "@patternfly/react-core/dist/esm/components/Badge";
import { Button } from "@patternfly/react-core/dist/esm/components/Button";
import { Card, CardBody, CardFooter, CardHeader, CardTitle } from "@patternfly/react-core/dist/esm/components/Card";
import { Content, ContentVariants } from "@patternfly/react-core/dist/esm/components/Content";
import { DropdownItem } from '@patternfly/react-core/dist/esm/components/Dropdown/index.js';
import { ExpandableSection } from "@patternfly/react-core/dist/esm/components/ExpandableSection";
import { Flex, FlexItem } from "@patternfly/react-core/dist/esm/layouts/Flex";
import { SortByDirection } from '@patternfly/react-table';
import { KebabDropdown } from "cockpit-components-dropdown.jsx";
import { useDialogs } from "dialogs.jsx";

import cockpit from 'cockpit';
import { ListingPanel } from 'cockpit-components-listing-panel';
import { ListingTable } from "cockpit-components-table";

import { ImageDeleteModal } from './ImageDeleteModal.tsx';
import ImageDetails from './ImageDetails.tsx';
import ImageHistory from './ImageHistory.tsx';
import { ImageRunModal } from './ImageRunModal.tsx';
import { ImageSearchModal } from './ImageSearchModal.tsx';
import PruneUnusedImagesModal from './PruneUnusedImagesModal.tsx';
import { RelativeTime } from './RelativeTime.tsx';
import * as client from '../lib/client.ts';
import { debug, image_name, truncate_id } from '../lib/util.ts';
import { UID_DOCKER_DESKTOP } from '../lib/rest.ts';
import { useDockerInfo } from '../lib/context.tsx';

import type { ListingTableColumnProps, ListingTableRowProps } from "cockpit-components-table";
import type { Connection } from '../lib/rest.ts';
import type { DockerImage, ImageUse, Notification, User } from '../lib/types.ts';

import '../styles/Images.scss';
import '@patternfly/react-styles/css/utilities/Sizing/sizing.css';

const _ = cockpit.gettext;

/** Props for the Images listing component */
interface ImagesProps {
    /** All images across owners, keyed by their globally unique key; null while loading */
    images: Record<string, DockerImage> | null;
    /** Mapping of image key to the containers using it; null while loading */
    imageContainerList: Record<string, ImageUse[]> | null;
    /** Callback reporting errors to the application as toast notifications */
    onAddNotification: (notification: Notification) => void;
    /** Active text search filter from the container header */
    textFilter: string;
    /** Active owner filter from the container header */
    ownerFilter: number | null | "all" | "user";
    /** Callback expanding all rows, used when navigating to an inactive container */
    showAll: () => void;
    /** Users that own a Docker daemon */
    users: User[];
}

/** A single column of the images table, compatible with the ListingTable rows */
interface ImagesRowColumn {
    title: React.ReactNode;
    header?: boolean;
    sortKey?: string | number;
    props?: Record<string, unknown>;
}

/** A single row of the images table, as consumed by the ListingTable */
interface ImagesRow {
    expandedContent: React.ReactNode;
    columns: ImagesRowColumn[];
    props: {
        key: string;
        "data-row-id": string;
        "data-row-name": string;
    };
}

/**
 * Whether an image is local-only, i.e. it cannot be pulled from any registry.
 *
 * Images tagged through the localhost pseudo-registry (the docker convention
 * for locally built images) have no registry-pullable tag, so re-pulling them
 * with "Pull" or "Pull all images" would always fail.
 */
const isLocalImage = (image: DockerImage): boolean => {
    const tags = image.RepoTags ?? [];
    return tags.length > 0 && tags.every(tag => tag.startsWith("localhost/"));
};

/**
 * The Images card listing all images of the selected owners.
 *
 * Each row shows the name, owner, creation time, id, disk usage and the
 * number of containers using it, and expands into Details and History tabs.
 * Actions at the top allow downloading new images, pulling all images and
 * pruning unused ones.
 */
const Images = ({ images, imageContainerList, onAddNotification, textFilter, ownerFilter, showAll, users }: ImagesProps) => {
    const Dialogs = useDialogs();
    const [intermediateOpened, setIntermediateOpened] = useState(false);
    const [isExpanded, setIsExpanded] = useState(false);
    // List of container image names which are being downloaded
    const [imageDownloadInProgress, setImageDownloadInProgress] = useState<string[]>([]);
    const [showPruneUnusedImagesModal, setShowPruneUnusedImagesModal] = useState(false);

    /**
     * Pull an image from a registry, tracking the download in the footer.
     *
     * @param imageName Name of the image to pull
     * @param imageTag  Optional tag to pull, "latest" is used on failure messages
     * @param con       Connection of the daemon to pull into
     */
    const downloadImage = (imageName: string, imageTag: string | null, con: Connection) => {
        let pullImageId = imageName;
        if (imageTag)
            pullImageId += `:${imageTag}`;

        setImageDownloadInProgress(previous => [...previous, imageName]);
        client.pullImage(con, pullImageId)
                .then(() => {
                    setImageDownloadInProgress(previous => previous.filter(image => image !== imageName));
                })
                .catch(ex => {
                    const error = cockpit.format(_("Failed to download image $0:$1"), imageName, imageTag || "latest");
                    const errorDetail = (
                        <p> {_("Error message")}:
                            <samp>{cockpit.format("$0 $1", ex.message, ex.reason)}</samp>
                        </p>
                    );
                    setImageDownloadInProgress(previous => previous.filter(image => image !== imageName));
                    onAddNotification({ type: 'danger', error, errorDetail });
                });
    };

    const onOpenNewImagesDialog = () => {
        Dialogs.show(<ImageSearchModal downloadImage={downloadImage} users={users} />);
    };

    /**
     * Resolve the connection of the daemon owning the given image.
     *
     * @param image The image to resolve the owner connection for
     * @returns The established connection of the image's owner
     */
    const _con_for = (image: DockerImage): Connection => {
        const user = users.find(u => u.uid === image.uid);
        cockpit.assert(user, `No user found for image uid ${image.uid}`);
        return user.con as Connection;
    };

    const onPullAllImages = () => Object.values(images ?? {}).forEach(image => {
        // Images tagged through the localhost/ pseudo-registry cannot be re-pulled;
        // pull the first tag that actually refers to a registry. Nameless
        // (intermediate) images are skipped entirely.
        const pullableTag = (image.RepoTags ?? []).find(tag => !tag.startsWith("localhost/"));
        if (pullableTag)
            downloadImage(pullableTag, null, _con_for(image));
        else
            debug("onPullAllImages: ignoring local image", image);
    });

    const onOpenPruneUnusedImagesDialog = () => {
        setShowPruneUnusedImagesModal(true);
    };

    const getUsedByText = (image: DockerImage): { title: string, count: number } => {
        if (imageContainerList === null) {
            return { title: _("unused"), count: 0 };
        }
        const containers = imageContainerList[image.key];
        if (containers !== undefined) {
            const title = cockpit.format(cockpit.ngettext("$0 container", "$0 containers", containers.length), containers.length);
            return { title, count: containers.length };
        } else {
            return { title: _("unused"), count: 0 };
        }
    };

    const calculateStats = (): { imageStats: { imagesTotal: number, imagesSize: number, unusedTotal: number, unusedSize: number }, unusedImages: DockerImage[] } => {
        const unusedImages: DockerImage[] = [];
        const imageStats = {
            imagesTotal: 0,
            imagesSize: 0,
            unusedTotal: 0,
            unusedSize: 0,
        };

        if (imageContainerList === null) {
            return { imageStats, unusedImages };
        }

        if (images !== null) {
            Object.keys(images).forEach(id => {
                const image = images[id];
                imageStats.imagesTotal += 1;
                imageStats.imagesSize += image.Size;

                const usedBy = imageContainerList[image.key];
                if (usedBy === undefined) {
                    imageStats.unusedTotal += 1;
                    imageStats.unusedSize += image.Size;
                    unusedImages.push(image);
                }
            });
        }

        return { imageStats, unusedImages };
    };

    const renderRow = (image: DockerImage): ImagesRow => {
        const tabs = [];
        const { title: usedByText, count: usedByCount } = getUsedByText(image);

        const user = users.find(user => user.uid === image.uid);
        cockpit.assert(user, `User not found for image uid ${image.uid}`);

        // Local images for the run dialog, in the format expected by the image typeahead
        let localImages: DockerImage[] | null = null;
        if (images) {
            localImages = Object.values(images)
                    .filter(img => (img.RepoTags?.length ?? 0) > 0)
                    .map(img => {
                        img.Name = image_name(img);
                        img.toString = function imgToString(this: DockerImage) { return this.Name ?? "" };
                        return img;
                    });
        }

        const columns: ImagesRowColumn[] = [
            {
                title: (
                    <>
                        <span className="image-name">{image_name(image)}</span>
                        {isLocalImage(image) && <Badge isRead className="ct-badge-image-local">{_("local")}</Badge>}
                    </>
                ),
                header: true,
                sortKey: image_name(image),
                props: { modifier: "breakWord" },
            },
            { title: (image.uid === 0) ? _("system") : <div><span className="ct-grey-text">{image.uid === UID_DOCKER_DESKTOP ? "" : `${_("user:")} `}</span>{user.name}</div>, props: { className: "ignore-pixels", modifier: "nowrap" }, sortKey: user.name },
            { title: <RelativeTime time={(image.Created ?? 0) * 1000} />, props: { className: "image-created" }, sortKey: image.Created ?? 0 },
            { title: truncate_id(image.Id), props: { className: "image-id" } },
            { title: cockpit.format_bytes(image.Size), props: { className: "ignore-pixels", modifier: "nowrap" }, sortKey: image.Size },
            { title: <span className={usedByCount === 0 ? "ct-grey-text" : ""}>{usedByText}</span>, props: { className: "ignore-pixels", modifier: "nowrap" }, sortKey: usedByCount },
            {
                title: (
                    <ImageActions
                        con={user.con as Connection}
                        image={image}
                        localImages={localImages}
                        onAddNotification={onAddNotification}
                        users={users}
                        downloadImage={downloadImage}
                    />
                ),
                props: { className: 'pf-v6-c-table__action content-action' }
            },
        ];

        tabs.push({
            name: _("Details"),
            renderer: ImageDetails,
            data: {
                image,
                containers: imageContainerList !== null ? imageContainerList[image.key] : null,
                showAll,
            }
        });
        tabs.push({
            name: _("History"),
            renderer: ImageHistory,
            data: { con: user.con as Connection, image }
        });
        return {
            expandedContent: <ListingPanel tabRenderers={tabs} />,
            columns,
            props: {
                key: image.key,
                "data-row-id": image.key,
                "data-row-name": `${image.uid === null ? 'user' : image.uid}-${image_name(image)}`
            },
        };
    };

    const columnTitles: ListingTableColumnProps[] = [
        { title: _("Image"), sortable: true, props: { width: 20 } },
        { title: _("Owner"), sortable: true, props: { className: "ignore-pixels" } },
        { title: _("Created"), sortable: true, props: { className: "ignore-pixels", width: 15 } },
        { title: _("ID"), props: { className: "ignore-pixels" } },
        { title: _("Disk space"), sortable: true, props: { className: "ignore-pixels" } },
        { title: _("Used by"), sortable: true, props: { className: "ignore-pixels" } },
    ];
    let emptyCaption = _("No images");
    if (images === null)
        emptyCaption = _("Loading...");
    else if (textFilter.length > 0)
        emptyCaption = _("No images that match the current filter");

    let filtered: string[] = [];
    if (images !== null) {
        filtered = Object.keys(images).filter(id => {
            const image = images[id];
            if (ownerFilter !== "all") {
                if (ownerFilter === "user") {
                    if (image.uid !== null)
                        return false;
                } else if (image.uid !== ownerFilter) {
                    return false;
                }
            }

            const tags = image.RepoTags || [];
            if (!intermediateOpened && tags.length < 1)
                return false;
            if (textFilter.length > 0)
                return tags.some(tag => tag.toLowerCase().indexOf(textFilter.toLowerCase()) >= 0);
            return true;
        });
    }

    filtered.sort((a, b) => {
        // User images are in front of system ones
        if (images![a].uid !== images![b].uid)
            return images![a].uid === 0 ? 1 : -1;
        const name_a = images![a].RepoTags ? images![a].RepoTags[0] : "";
        const name_b = images![b].RepoTags ? images![b].RepoTags[0] : "";
        if (name_a === "")
            return 1;
        if (name_b === "")
            return -1;
        return name_a > name_b ? 1 : -1;
    });

    const imageRows = filtered.map(id => renderRow(images![id])) as unknown as ListingTableRowProps[];

    const sortRows = (rows: ListingTableRowProps[], direction: SortByDirection, idx: number) => {
        // Image / Owner / Created / ID / Disk space / Used by
        const isNumeric = idx === 2 || idx === 4 || idx === 5;
        const sortedRows = rows.sort((a, b) => {
            const aitem = (a.columns[idx] as ImagesRowColumn).sortKey ?? (a.columns[idx] as ImagesRowColumn).title;
            const bitem = (b.columns[idx] as ImagesRowColumn).sortKey ?? (b.columns[idx] as ImagesRowColumn).title;

            if (isNumeric) {
                return Number(bitem) - Number(aitem);
            } else {
                return String(aitem).localeCompare(String(bitem));
            }
        });
        return direction === SortByDirection.asc ? sortedRows : sortedRows.reverse();
    };

    let interim = false;
    if (images) {
        interim = Object.keys(images).some(id => {
            // Intermediate image does not have any tags
            if (images[id].RepoTags && images[id].RepoTags.length > 0)
                return false;

            // Only filter by selected user
            if (ownerFilter !== "all") {
                if (ownerFilter === "user")
                    return images[id].uid === null;
                return images[id].uid === ownerFilter;
            }

            // Any text filter hides all images
            if (textFilter.length > 0)
                return false;

            return true;
        });
    }

    let toggleIntermediate: string | React.ReactNode = "";
    if (interim) {
        toggleIntermediate = (
            <span className="listing-action">
                <Button variant="link" onClick={() => { setIntermediateOpened(!intermediateOpened); setIsExpanded(true) }}>
                    {intermediateOpened ? _("Hide intermediate images") : _("Show intermediate images")}
                </Button>
            </span>
        );
    }
    const cardBody = (
        <>
            <ListingTable
                aria-label={_("Images")}
                variant='compact'
                emptyCaption={emptyCaption}
                columns={columnTitles}
                rows={imageRows}
                sortMethod={sortRows}
                sortBy={{ index: 1, direction: SortByDirection.asc }}
            />
            {toggleIntermediate}
        </>
    );

    const { imageStats, unusedImages } = calculateStats();
    const imageTitleStats = (
        <>
            <Content>
                {cockpit.format(cockpit.ngettext("$0 image total, $1", "$0 images total, $1", imageStats.imagesTotal), imageStats.imagesTotal, cockpit.format_bytes(imageStats.imagesSize))}
            </Content>
            {imageStats.unusedTotal !== 0 &&
                <Content>
                    {cockpit.format(cockpit.ngettext("$0 unused image, $1", "$0 unused images, $1", imageStats.unusedTotal), imageStats.unusedTotal, cockpit.format_bytes(imageStats.unusedSize))}
                </Content>}
        </>
    );

    return (
        <Card id="containers-images" key="images" className="containers-images">
            <CardHeader>
                <Flex flexWrap={{ default: 'nowrap' }} className="pf-v6-u-w-100">
                    <FlexItem grow={{ default: 'grow' }}>
                        <Flex>
                            <CardTitle>
                                <Content component={ContentVariants.h1} className="containers-images-title">{_("Images")}</Content>
                            </CardTitle>
                            <Flex className="ignore-pixels" style={{ rowGap: "var(--pf-t--global--spacer--xs)" }}>{imageTitleStats}</Flex>
                        </Flex>
                    </FlexItem>
                    <FlexItem>
                        <ImageOverActions
                            handleDownloadNewImage={onOpenNewImagesDialog}
                            handlePullAllImages={onPullAllImages}
                            handlePruneUsedImages={onOpenPruneUnusedImagesDialog}
                            unusedImages={unusedImages}
                        />
                    </FlexItem>
                </Flex>
            </CardHeader>
            <CardBody>
                {images && Object.keys(images).length
                    ? (
                        <ExpandableSection
                            toggleText={isExpanded ? _("Hide images") : _("Show images")}
                            onToggle={() => setIsExpanded(prev => !prev)}
                            isExpanded={isExpanded}
                        >
                            {cardBody}
                        </ExpandableSection>
                    )
                    : cardBody}
            </CardBody>
            {/* The PruneUnusedImagesModal dialog needs to keep
              * its list of unused images in sync with reality at
              * all times since the API call will delete whatever
              * is unused at the exact time of call, and the
              * dialog better be showing the correct list of
              * unused images at that time.  Thus, we can't use
              * Dialog.show for it but include it here in the
              * DOM. */}
            {showPruneUnusedImagesModal && (
                <PruneUnusedImagesModal
                    close={() => setShowPruneUnusedImagesModal(false)}
                    unusedImages={unusedImages}
                    onAddNotification={onAddNotification}
                    users={users}
                />
            )}
            {imageDownloadInProgress.length > 0 && (
                <CardFooter>
                    <div className='download-in-progress'> {_("Pulling")} {imageDownloadInProgress.join(', ')}... </div>
                </CardFooter>
            )}
        </Card>
    );
};

/** Props for the card-level action kebab */
type ImageOverActionsProps = {
    /** Callback opening the image search/download dialog */
    handleDownloadNewImage: () => void,
    /** Callback pulling all taggable images */
    handlePullAllImages: () => void,
    /** Callback opening the prune-unused-images dialog */
    handlePruneUsedImages: () => void,
    /** Images not used by any container, disabling prune when empty */
    unusedImages: DockerImage[],
};

/**
 * The kebab menu in the card header offering download, pull-all and prune
 * actions for the whole image set.
 */
const ImageOverActions = ({ handleDownloadNewImage, handlePullAllImages, handlePruneUsedImages, unusedImages }: ImageOverActionsProps) => {
    const actions = [
        <DropdownItem
            key="download-new-image"
            component="button"
            onClick={() => handleDownloadNewImage()}
        >
            {_("Download new image")}
        </DropdownItem>,
        <DropdownItem
            key="pull-all-images"
            component="button"
            onClick={() => handlePullAllImages()}
        >
            {_("Pull all images")}
        </DropdownItem>,
        <DropdownItem
            key="prune-unused-images"
            id="prune-unused-images-button"
            component="button"
            className="pf-m-danger btn-delete"
            onClick={() => handlePruneUsedImages()}
            isDisabled={unusedImages.length === 0}
            isAriaDisabled={unusedImages.length === 0}
        >
            {_("Prune unused images")}
        </DropdownItem>
    ];

    return (
        <KebabDropdown
            toggleButtonId="image-actions-dropdown"
            position="right"
            dropdownItems={actions}
        />
    );
};

/** Props for the per-row action buttons */
type ImageActionsProps = {
    /** Connection of the image's owner daemon */
    con: Connection,
    /** The image the actions operate on */
    image: DockerImage,
    /** Local images offered to the run dialog's typeahead */
    localImages: DockerImage[] | null,
    /** Callback reporting errors as toast notifications */
    onAddNotification: (notification: Notification) => void,
    /** Users that own a Docker daemon */
    users: User[],
    /** Callback pulling the image from a registry */
    downloadImage: (imageName: string, imageTag: string | null, con: Connection) => void,
};

/**
 * The per-row actions: create a container from the image, pull it again, or
 * delete it. Creating a container opens the ImageRunModal dialog.
 */
const ImageActions = ({ con, image, localImages, onAddNotification, users, downloadImage }: ImageActionsProps) => {
    const Dialogs = useDialogs();
    const dockerInfo = useDockerInfo();
    cockpit.assert(dockerInfo, "Docker info not available");

    const runImage = () => {
        Dialogs.show(
            <ImageRunModal
                users={users}
                image={image}
                localImages={localImages}
                onAddNotification={onAddNotification}
                dockerInfo={dockerInfo}
                dialogs={Dialogs}
            />
        );
    };

    const pullImage = () => {
        downloadImage(image_name(image), null, con);
    };

    const removeImage = () => {
        Dialogs.show(
            <ImageDeleteModal
                con={con}
                imageWillDelete={image}
                onAddNotification={onAddNotification}
            />
        );
    };

    const runImageAction = (
        <Button
            key={`${image.Id}create`}
            className="ct-container-create show-only-when-wide"
            variant='secondary'
            onClick={e => {
                e.stopPropagation();
                runImage();
            }}
            size="sm"
        >
            {_("Create container")}
        </Button>
    );

    const dropdownActions = [
        <DropdownItem
            key={`${image.Id}create-menu`}
            component="button"
            className="show-only-when-narrow"
            onClick={runImage}
        >
            {_("Create container")}
        </DropdownItem>,
        <DropdownItem
            key={`${image.Id}pull`}
            component="button"
            onClick={pullImage}
            isDisabled={isLocalImage(image)}
            isAriaDisabled={isLocalImage(image)}
        >
            {_("Pull")}
        </DropdownItem>,
        <DropdownItem
            key={`${image.Id}delete`}
            component="button"
            className="pf-m-danger btn-delete"
            onClick={removeImage}
        >
            {_("Delete")}
        </DropdownItem>
    ];

    return (
        <>
            {runImageAction}
            <KebabDropdown position="right" dropdownItems={dropdownActions} />
        </>
    );
};

export default Images;
