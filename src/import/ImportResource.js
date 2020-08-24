'use strict';

const _ = require(`lodash`);
const util = require(`../util/util`);
const resourceTemplate = require('./json/resource.json');
const componentTemplate = require('./json/component.json');

module.exports = (router) => {
    const form = router.formio.mongoose.model('form');

    /**
     * Method to save resource data into database
     * @param data Key-Value pair to load into database
     * @param formId Form id to relate the data
     */
    const submitResourcesData = (data, formId, req, next) => {
        if (formId) {
            const submission =  router.formio.mongoose.model('submission');
            for (const submit of data) {
                submit.submit = true;
                submission({
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
     * Method to create resource and load data into database
     * @param resources Json that include definition of resources and data
     */
    const createResource = (resources, req, res, next) => {
        const newResource = JSON.parse(JSON.stringify(resourceTemplate));
        newResource.title = resources.title;
        newResource.name = resources.name;
        newResource.path = resources.path;
        newResource.owner = req.user.owner;
        newResource.roles = req.user.roles;

        newResource.access.forEach((item) => {
            item.roles = req.user.roles;
        });

        newResource.submissionAccess.forEach((item) => {
            item.roles = req.user.roles;
        });

        //For default, every resource that insert automatically has two fields, Codigo and Valor
        const keyComponent = JSON.parse(JSON.stringify(componentTemplate));
        keyComponent.label = "Codigo";
        keyComponent.key = "codigo";

        const valueComponent = JSON.parse(JSON.stringify(componentTemplate));
        valueComponent.label = "Valor";
        valueComponent.key = "valor";

        newResource.components.unshift(valueComponent);
        newResource.components.unshift(keyComponent);

        //Create a save the new resource into database
        form(newResource).save(function(err, form) {
            if (err) {
                return next(err.message || err);
            }
            else {
                //Load data relating to the previously created resource
                submitResourcesData(resources.data, form._id, req, (err, data) => {
                    if (err) {
                        return next(err.message || err);
                    }
                    return res.status(200).send('Ok');
                });
            }
        });
    };

    // Implement an import endpoint.
    if (router.post) {
        router.post('/import-resources', (req, res, next) => {
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

            util.log(resources.data[0]);

            //Find if exists the resource
            form.findOne({"name": resources.name, "path": resources.path}, '_id', function(err, form) {
                if (err) {
                    return next(err.message || err);
                }
                else {
                    //If not exists, we will create it
                    if (!form) {
                        createResource(resources, req, res, (err, data) => {
                            if (err) {
                                return next(err.message || err);
                            }
                            return res.status(200).send('Ok');
                        });
                    }
                    else {
                        //If exist, we will load data using the id
                        submitResourcesData(resources.data, form._id, req, (err, data) => {
                            if (err) {
                                return next(err.message || err);
                            }
                            return res.status(200).send('Ok');
                        });
                    }
                }
            });
            return res.status(200).send('Ok');
        });
    }
};
