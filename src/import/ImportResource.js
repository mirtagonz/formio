'use strict';

const _ = require(`lodash`);
const promisify = require('util').promisify;
const resourceTemplate = require('./json/resource.json');
const componentTemplate = require('./json/component.json');

/**
 * This endpoint can create/update a key/value resource with submission data from minimal definition
 * especially for use within select components. This is useful for creating this kind of resources
 * dynamically from external data sources like external apis or databases.
 * @param router
 */
module.exports = (router) => {
    const form = router.formio.mongoose.model('form');
    const hook = require('../util/hook')(router.formio);

    /**
     * Method to retrieve roles based on request user
     * @param req
     * @param res
     * @param next
     * @returns {Promise<{roles: *, forms: *}>}
     */
    const accessHandler = async (req, res, next) => {
        // Load all the roles.
        const roles = {};
        const roleResult = await router.formio.resources.role.model
            .find(hook.alter('roleQuery', {deleted: {$eq: null}}, req))
            .select({title: 1, admin: 1, default: 1})
            .lean()
            .exec();

        if (!roleResult) {
            throw "Could not load the Roles.";
        }

        roleResult.forEach((role) => {
            if (role.title) {
                roles[role.title.replace(/\s/g, '').toLowerCase()] = role;
            }
        });

        // Load all the forms.
        const forms = {};

        try {
            const formResult = await router.formio.resources.form.model
                .find(hook.alter('formQuery', {deleted: {$eq: null}}, req))
                .select({title: 1, name: 1, path: 1, access: 1, submissionAccess: 1})
                .lean()
                .exec();

            if (!formResult) {
                throw "Could not load the Forms.";
            }

            formResult.forEach(formItem => forms[formItem.name] = formItem);
        }
        catch (err) {
            throw "Could not load the Forms.";
        }

        // Fetch current user's access
        /* eslint-disable require-atomic-updates */
        req.userAccess = await promisify(router.formio.access.getAccess)(req, res);
        /* eslint-enable require-atomic-updates */

        // Allow other systems to add to the access information or disable filtering
        const accessInfo = await promisify(hook.alter)('accessInfo', {roles, forms, req, filterEnabled: true});

        // Perform access filtering if still enabled
        if (accessInfo.filterEnabled) {
            // Only include forms where the requester's roles have overlap with form definition read access roles
            accessInfo.forms = _.pickBy(accessInfo.forms, formItem => {
                const formDefinitionAccess = formItem.access.find(perm => perm.type === 'read_all') || {};
                const formDefinitionAccessRoles = (formDefinitionAccess.roles || []).map(id => id.toString());

                return _.intersection(req.userAccess.roles, formDefinitionAccessRoles).length > 0;
            });
        }
        return {roles: accessInfo.roles, forms: accessInfo.forms};
    };

    /**
     * Method returning an array with roles id's
     * @param accessRoles
     * @returns {[]}
     */
    const getRoles = (accessRoles) => {
        const roles = [];
        _.each(accessRoles, (accessRole) => {
            roles.push(accessRole._id);
        });
        return roles;
    };

    /**
     * Method to save resource data into database
     * @param data Key-Value pair to load into database
     * @param formId Form id to relate the data
     * @param req
     */
    const submitResourcesData = async (data, formId, req) => {
        console.debug("Submitting form data: ", formId, data);
        if (formId) {
            const submission = router.formio.mongoose.model('submission');
            for (const submit of data) {
                submit.submit = true;
                await submission({
                    "data": submit,
                    "form": formId,
                    "access": req.user.access,
                    "externalIds": req.user.externalIds,
                    "owner": req.user.owner,
                    "deleted": req.user.deleted,
                    "roles": req.user.roles
                }).save();
            }
        }
    };

    /**
     * Method that creates resources components dynamically
     * @param resources
     */
    const createComponents = (resources) => {
        if (resources.data && resources.data.length > 0) {
            console.debug("creating dynamic components");
            const firstElement = resources.data[0];
            for (const key in firstElement) {
                const component = JSON.parse(JSON.stringify(componentTemplate));
                component.label = key;
                component.key = key;
                resources.components.unshift(component);
            }
        }
    };

    /**
     * Method to create resource and load data into database
     * @param resources Json that include definition of resources and data
     * @param req
     * @param res
     * @param next
     */
    const createResource = async (resources, req, res, next) => {
        const newResource = JSON.parse(JSON.stringify(resourceTemplate));
        newResource._id = resources._id;
        newResource.title = resources.title;
        newResource.name = resources.name;
        newResource.path = resources.path;
        newResource.owner = req.user.owner;
        newResource.roles = req.user.roles;
        newResource.tags = ["builder"];

        const access = await accessHandler(req, res, next);
        newResource.access.forEach((item) => {
            item.roles = getRoles(access.roles);
        });
        newResource.submissionAccess.forEach((item) => {
            item.roles = getRoles(access.roles);
        });

        newResource.data = resources.data;
        createComponents(newResource);

        //Create a save the new resource into database
        const createdForm = await form(newResource).save();
        await submitResourcesData(newResource.data, createdForm._id, req);
        return createdForm;
    };

    /**
     * Method to reactivate a deleted resource
     * @param existingForm Object representing the existing form
     * @param resources Json that include definition of request resource
     * @param req
     * @param res
     * @param next
     */
    const reactivateResource = async (existingForm, resources, req, res, next) => {
        const formId = existingForm._id;
        console.debug("Reactivating resource");
        const existingResource = JSON.parse(JSON.stringify(resourceTemplate));
        existingResource.title = resources.title;
        existingResource.name = resources.name;
        existingResource.path = resources.path;
        existingResource.owner = req.user.owner;
        existingResource.roles = req.user.roles;
        existingResource.machineName = existingForm.machineName;
        existingResource.modified = new Date();
        existingResource.deleted = null;
        existingResource.tags = ["builder"];

        const access = await accessHandler(req, res, next);
        existingResource.access.forEach((item) => {
            item.roles = getRoles(access.roles);
        });
        existingResource.submissionAccess.forEach((item) => {
            item.roles = getRoles(access.roles);
        });

        existingResource.data = resources.data;
        createComponents(existingResource);

        // Replacing existing resource attributes except the _id
        console.debug("Replacing attributes");
        const reactivatedForm = await form.replaceOne({_id: formId}, existingResource);
        await submitResourcesData(existingResource.data, formId, req);
        return reactivatedForm;
    };

    // Implement an import endpoint.
    if (router.post) {
        router.post('/import-resources', async (req, res, next) => {
            console.debug("Importing resources");
            //Check that the user is and admin and has token
            if (!req.isAdmin && !_.has(req, 'token.user._id')) {
                return res.sendStatus(400);
            }

            //Convert to json
            let resources = req.body;
            if (typeof template === 'string') {
                resources = JSON.parse(resources);
            }

            //Check if the json has the correct structure
            if (!resources) {
                return res.status(400).send('No data provided');
            }
            else if (!resources.hasOwnProperty('title') || !resources.hasOwnProperty('name')
                || !resources.hasOwnProperty('path') || !resources.hasOwnProperty('data')) {
                return res.status(400).send('Data does not have the required structure');
            }

            try {
                const hasData = resources.data && resources.data.length > 0;
                console.debug("Has data: ", hasData);
                if (!hasData) {
                    return res.status(200).send('Data is empty so we skip resource creation/update');
                }

                // Find if the resource exists
                let retrievedForm;
                if (resources._id) {
                    console.debug("Retrieving form: ", resources._id);
                    retrievedForm = await form.findOne({"_id": resources._id});
                }
                else {
                    retrievedForm = await form.findOne({"name": resources.name, "path": resources.path});
                }
                console.debug("Form Exist: ", retrievedForm !== undefined && retrievedForm !== null);
                // If doesn't exists, we create a new one
                if (!retrievedForm) {
                    console.debug("Creating new resource");
                    const createdForm = await createResource(resources, req, res);
                    return res.status(200).send(createdForm);
                }

                // If deleted we reactivate the existing resource
                if (retrievedForm.deleted) {
                    const updatedForm = await reactivateResource(retrievedForm, resources, req, res);
                    return res.status(200).send(updatedForm);
                }
                // If exist and not deleted we send only the submission data
                await submitResourcesData(resources.data, retrievedForm._id, req);
                return res.status(200).send(retrievedForm);
            }
            catch (e) {
                console.error("Formio Error: ", e);
                return next("Error while importing Resource");
            }
        });
    }
};
